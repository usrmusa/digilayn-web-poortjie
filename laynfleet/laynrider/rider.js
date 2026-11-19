/**
 * rider.js — LaynFleet Rider Web Client
 *
 * Handles Global Authentication, Profile Gating, Suspension checks,
 * Real-time Online Drivers listener, Transport Category filtering,
 * Quick Ride auto-dispatch, Geofencing, Google Places Autocomplete,
 * Quote Handshake (with Driver Identity & 60s countdown), and Live Trip Tracking.
 *
 * Strict camelCase schema adhering to the Android App source of truth.
 */
(function (global) {
  'use strict';

  // 1. Firebase instances initialized globally from scripts/firebase.js
  const auth = global.auth || firebase.auth();
  const db = global.db || firebase.firestore();
  const rtdb = global.rtdb || firebase.database();
  const storage = global.storage || firebase.storage();

  const FS = global.FS;
  if (!FS) throw new Error('Firebase layout is required');
  const urlEnv = new URLSearchParams(window.location.search).get('env');
  const fleetEnvironment = (urlEnv === 'dev' || urlEnv === 'prod') ? urlEnv : 'prod';
  const riderApi = new global.RiderApi({
    get currentUser() { return global.AccountAccess.currentUser; },
    signOut: () => auth.signOut()
  });
  const RTDB_LOCATIONS = `laynfleet/${fleetEnvironment}/driverLocations`;
  const HEARTBEAT_FRESHNESS_WINDOW_MS = global.HEARTBEAT_FRESHNESS_WINDOW_MS || 60000;
  const SERVICE_AREA = global.SERVICE_AREA || {
    center: { lat: -26.458127, lng: 27.768157 },
    radiusMeters: 175933
  };
  const POORTJIE_LOCAL_AREA = global.POORTJIE_LOCAL_AREA || {
    center: { lat: -26.45600, lng: 27.77087 },
    radiusMeters: 1637
  };
  const POORTJIE_MAP_CENTER = { lat: -26.4568052, lng: 27.7678277 }; // Poortjie Taxi Rank

  /** Reads an epoch-millis field stored as a Firestore Timestamp or a Long. */
  function readEpochMillis(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    return null;
  }

  // Collections
  const driversCol = db.collection(FS.laynfleet).doc(fleetEnvironment).collection(FS.drivers);
  function quickRequestsFor(riderUid) {
    if (!riderUid) throw new Error('Sign in required.');
    return db.collection(FS.laynfleet).doc(fleetEnvironment)
      .collection('quickRequests').doc(riderUid).collection('requests');
  }
  const ratingsCol = db.collection(FS.laynfleet).doc(fleetEnvironment).collection(FS.ratings);
  const reviewLikesCol = db.collection(FS.laynfleet).doc(fleetEnvironment).collection(FS.reviewLikes);
  const usersCol = db.collection(FS.users);

  // State
  let currentUser = null;
  let userProfile = null;
  let isProfileComplete = false;

  let rtdbPresence = {};
  let presenceUnsub = null;
  let activeBookingUnsub = null;
  let currentBookingDoc = null;

  let activeDriverModal = null;
  let bookingTargetDriver = null; // null for Quick Ride

  // Timers
  let pendingTimerInterval = null;
  let quoteTimerInterval = null;

  // Rating State
  let selectedStars = 5;

  // Booking Form State
  let bookingState = {
    type: 'ASAP', // 'ASAP' | 'SCHEDULED'
    pickup: {
      address: '',
      lat: null,
      lng: null
    },
    dropoff: {
      address: '',
      lat: null,
      lng: null
    },
    note: '',
    vehicleType: 'PRIVATE_CAR',
    isReturnTrip: true,
    returnWaitMinutes: 15,
    waitPriceSnapshot: null,
    scheduledEpoch: null,
    actualOneWayDistanceKm: null, // Populated ONLY when actual driving road distance is measured by Google Directions
    upfrontPrice: null,
    estimatedDistanceKm: null,
    ratePerKmSnapshot: null,
    minimumFareSnapshot: null,
    curveScaleKmSnapshot: null,
    returnPercentSnapshot: null
  };

  const DEFAULT_PRICING_RATES = {
    PRIVATE_CAR: { ratePerKm: 10.0, minimumFare: 25.0, returnTripPercent: 80.0, waitRatePerMinute: 1.50, freeWaitMinutes: 10, curveScaleKm: null },
    MINI_BUS: { ratePerKm: 12.0, minimumFare: 30.0, returnTripPercent: 80.0, waitRatePerMinute: 1.50, freeWaitMinutes: 10, curveScaleKm: null },
    BAKKIE: { ratePerKm: 12.0, minimumFare: 30.0, returnTripPercent: 80.0, waitRatePerMinute: 1.50, freeWaitMinutes: 10, curveScaleKm: null },
    MOTORBIKE: { ratePerKm: 7.0, minimumFare: 18.0, returnTripPercent: 80.0, waitRatePerMinute: 1.50, freeWaitMinutes: 10, curveScaleKm: null },
    TUK_TUK: { ratePerKm: 6.0, minimumFare: 15.0, returnTripPercent: 80.0, waitRatePerMinute: 1.50, freeWaitMinutes: 10, curveScaleKm: null }
  };
  let activePricingRates = { ...DEFAULT_PRICING_RATES };

  function getPricingSnapshot(vehicleType = 'PRIVATE_CAR') {
    const vType = (vehicleType || 'PRIVATE_CAR').toUpperCase();
    const r = activePricingRates[vType] || DEFAULT_PRICING_RATES[vType] || DEFAULT_PRICING_RATES.PRIVATE_CAR;
    return {
      ratePerKm: Number(r.ratePerKm),
      minimumFare: Number(r.minimumFare),
      curveScaleKm: (typeof r.curveScaleKm === 'number' && Number.isFinite(r.curveScaleKm) && r.curveScaleKm > 0) ? r.curveScaleKm : null,
      returnRidePercent: Number(r.returnRidePercent ?? r.returnTripPercent ?? 80),
      waitRatePerMinute: Number(r.waitRatePerMinute ?? 1.50),
      freeWaitMinutes: Number(r.freeWaitMinutes ?? 10)
    };
  }

  // User cache for driver identities & reviews
  const userCache = new Map();
  const driverReviewsCache = new Map();

  // DOM Elements - App Views
  const bootView = document.getElementById('boot-view');
  const authGateView = document.getElementById('auth-gate-view');
  const suspendedView = document.getElementById('suspended-view');
  const appView = document.getElementById('app-view');

  // Header Elements
  const headerUserBtn = document.getElementById('header-user-btn');
  const headerAvatar = document.getElementById('header-avatar');
  const headerUserName = document.getElementById('header-user-name');
  const headerSignOutBtn = document.getElementById('header-signout-btn');
  const headerSignInBtn = document.getElementById('header-signin-btn');

  // Dashboard Banners & CTA
  const profileIncompleteBanner = document.getElementById('profile-incomplete-banner');
  const completeProfileBtn = document.getElementById('complete-profile-btn');
  const activeBookingBanner = document.getElementById('active-booking-banner');
  const activeBookingIcon = document.getElementById('active-booking-icon');
  const activeBookingTitle = document.getElementById('active-booking-title');
  const activeBookingCountdownPill = document.getElementById('active-booking-countdown-pill');
  const activeBookingStatusText = document.getElementById('active-booking-status-text');
  const viewActiveBookingBtn = document.getElementById('view-active-booking-btn');
  const quickRideBtn = document.getElementById('quick-ride-btn');

  // Filter Chips & Lists
  const filterChips = document.querySelectorAll('.filter-chip');
  const availableListEl = document.getElementById('available-drivers-list');
  const busyListEl = document.getElementById('busy-drivers-list');
  const availableSectionEl = document.getElementById('section-available');
  const busySectionEl = document.getElementById('section-busy');
  const availableCountEl = document.getElementById('available-count');
  const busyCountEl = document.getElementById('busy-count');
  const headerDriverCountEl = document.getElementById('header-driver-count');
  const heroDriverCountBadge = document.getElementById('hero-driver-count-badge');
  const emptyDriversView = document.getElementById('empty-drivers-view');

  // Driver Modal Elements
  const driverModal = document.getElementById('driver-modal');
  const driverModalClose = document.getElementById('driver-modal-close');
  const driverModalCancel = document.getElementById('driver-modal-cancel');
  const driverModalSelectBtn = document.getElementById('driver-modal-select-btn');
  const driverModalAvatar = document.getElementById('driver-modal-avatar');
  const driverModalName = document.getElementById('driver-modal-name');
  const driverModalVehicleType = document.getElementById('driver-modal-vehicle-type');
  const driverModalStatus = document.getElementById('driver-modal-status');
  const driverModalRating = document.getElementById('driver-modal-rating');
  const driverModalTrips = document.getElementById('driver-modal-trips');
  const driverModalSeats = document.getElementById('driver-modal-seats');
  const driverModalVehicleDesc = document.getElementById('driver-modal-vehicle-desc');
  const driverModalPlate = document.getElementById('driver-modal-plate');
  const driverModalReviewsList = document.getElementById('driver-modal-reviews-list');

  // Booking Modal Elements
  const bookingModal = document.getElementById('booking-modal');
  const bookingModalClose = document.getElementById('booking-modal-close');
  const bookingModalCancel = document.getElementById('booking-modal-cancel');
  const bookingModalBack = document.getElementById('booking-modal-back');
  const bookingStepTitle = document.getElementById('booking-step-title');
  const bookingStepSubtitle = document.getElementById('booking-step-subtitle');
  const bookingStepIndicator1 = document.getElementById('booking-step-indicator-1');
  const bookingStepIndicator2 = document.getElementById('booking-step-indicator-2');
  const bookingStepIndicator3 = document.getElementById('booking-step-indicator-3');
  const bookingStepPickup = document.getElementById('booking-step-pickup');
  const bookingStepDropoff = document.getElementById('booking-step-dropoff');
  const bookingStepOptions = document.getElementById('booking-step-options');
  const bookingMapContainerStep1 = document.getElementById('booking-map-container-step1');
  const bookingMapContainerStep2 = document.getElementById('booking-map-container-step2');
  const bookingMapContainerStep3 = document.getElementById('booking-map-container-step3');
  const step2PickupSummaryText = document.getElementById('step2-pickup-summary-text');
  const step2ChangePickupBtn = document.getElementById('step2-change-pickup-btn');
  const step2TripTypeSection = document.getElementById('step2-trip-type-section');
  const step2TripSingleBtn = document.getElementById('step2-trip-single-btn');
  const step2TripReturnBtn = document.getElementById('step2-trip-return-btn');
  const step2ReturnDurationSection = document.getElementById('step2-return-duration-section');
  const step2ReturnContinueBtn = document.getElementById('step2-return-continue-btn');
  const reviewPickupAddress = document.getElementById('review-pickup-address');
  const reviewDropoffAddress = document.getElementById('review-dropoff-address');
  const reviewTripTypeVal = document.getElementById('review-trip-type-val');
  const reviewTripTypeIcon = document.getElementById('review-trip-type-icon');
  const reviewRouteDistanceBadge = document.getElementById('review-route-distance-badge');
  const reviewRouteDurationBadge = document.getElementById('review-route-duration-badge');
  const reviewEditPickupBtn = document.getElementById('review-edit-pickup-btn');
  const reviewEditDropoffBtn = document.getElementById('review-edit-dropoff-btn');
  const reviewEditTypeBtn = document.getElementById('review-edit-type-btn');
  const bookingScheduleBtn = document.getElementById('booking-schedule-btn');

  const bookingForm = document.getElementById('booking-form');
  const bookingSubmitBtn = document.getElementById('booking-submit-btn');
  const bookingTargetTitle = document.getElementById('booking-target-title');
  const bookingTargetSubtitle = document.getElementById('booking-target-subtitle');
  const bookingTargetTypeBadge = document.getElementById('booking-target-type-badge');
  const toggleTripReturn = document.getElementById('toggle-trip-return');
  const toggleTripSingle = document.getElementById('toggle-trip-single');
  const toggleTypeAsap = document.getElementById('toggle-type-asap');
  const toggleTypeScheduled = document.getElementById('toggle-type-scheduled');
  const scheduledFields = document.getElementById('scheduled-fields');
  const scheduledDateInput = document.getElementById('booking-scheduled-date');
  const scheduledTimeInput = document.getElementById('booking-scheduled-time');
  const pickupAddressInput = document.getElementById('booking-pickup-address');
  const pickupClearBtn = document.getElementById('pickup-clear-btn');
  const pickupGpsBtn = document.getElementById('pickup-gps-btn');
  const pickupGeofenceBadge = document.getElementById('pickup-geofence-badge');
  const pickupErrorEl = document.getElementById('pickup-error');
  const dropoffAddressInput = document.getElementById('booking-dropoff-address');
  const dropoffClearBtn = document.getElementById('dropoff-clear-btn');
  const dropoffErrorEl = document.getElementById('dropoff-error');
  const bookingNoteInput = document.getElementById('booking-note');
  const bookingNoteCount = document.getElementById('booking-note-count');
  const bookingFormError = document.getElementById('booking-form-error');

  // Active Trip / Tracking Modal Elements
  const activeTripModal = document.getElementById('active-trip-modal');
  const activeTripModalClose = document.getElementById('active-trip-modal-close');
  const trackBookingId = document.getElementById('track-booking-id');

  // Stepper Elements (Direct Accept Model: Request -> Accepted -> En Route -> In Trip -> Done)
  const stepRequested = document.getElementById('step-requested');
  const stepAccepted = document.getElementById('step-accepted');
  const stepEnroute = document.getElementById('step-enroute');
  const stepTrip = document.getElementById('step-trip');
  const stepCompleted = document.getElementById('step-completed');

  // Trip State Sections
  const trackPendingSection = document.getElementById('track-pending-section');
  const pendingSectionTitle = document.getElementById('pending-section-title');
  const pendingSectionDesc = document.getElementById('pending-section-desc');
  const pendingCountdownLabel = document.getElementById('pending-countdown-label');
  const pendingCountdown = document.getElementById('pending-countdown');
  const cancelPendingBtn = document.getElementById('cancel-pending-btn');

  const trackActiveSection = document.getElementById('track-active-section');
  const trackStatusIcon = document.getElementById('track-status-icon');
  const trackStatusTitle = document.getElementById('track-status-title');
  const trackStatusDesc = document.getElementById('track-status-desc');
  const trackDriverAvatar = document.getElementById('track-driver-avatar');
  const trackDriverName = document.getElementById('track-driver-name');
  const trackVehicleDesc = document.getElementById('track-vehicle-desc');
  const trackVehiclePlate = document.getElementById('track-vehicle-plate');
  const trackCallBtn = document.getElementById('track-call-btn');
  const trackWhatsappBtn = document.getElementById('track-whatsapp-btn');
  const trackPickupText = document.getElementById('track-pickup-text');
  const trackDropoffText = document.getElementById('track-dropoff-text');
  const trackFareText = document.getElementById('track-fare-text');

  const trackCompletedSection = document.getElementById('track-completed-section');
  const completedDistanceAmount = document.getElementById('completed-distance-amount');
  const completedDoneBtn = document.getElementById('completed-done-btn');
  const tripReviewComment = document.getElementById('trip-review-comment');
  const ratingStarBtns = document.querySelectorAll('.rating-star-btn');

  const trackCancelledSection = document.getElementById('track-cancelled-section');
  const cancelledIcon = document.getElementById('cancelled-icon');
  const cancelledTitle = document.getElementById('cancelled-title');
  const cancelledReasonText = document.getElementById('cancelled-reason-text');
  const cancelledDismissBtn = document.getElementById('cancelled-dismiss-btn');

  // Map Elements
  const bookingMapCard = document.getElementById('booking-map-card');
  const bookingMapEl = document.getElementById('booking-map');
  const bookingMapRouteInfo = document.getElementById('booking-map-route-info');
  const bookingMapDistance = document.getElementById('booking-map-distance');
  const bookingMapDuration = document.getElementById('booking-map-duration');

  const trackingMapCard = document.getElementById('tracking-map-card');
  const trackingMapEl = document.getElementById('tracking-map');
  const trackingMapRouteInfo = document.getElementById('tracking-map-route-info');
  const trackingMapDistance = document.getElementById('tracking-map-distance');
  const trackingMapDuration = document.getElementById('tracking-map-duration');

  // Google Maps State
  let bookingGoogleMap = null;
  let bookingDirectionsService = null;
  let bookingDirectionsRenderer = null;
  let bookingPickupMarker = null;
  let bookingDropoffMarker = null;
  let bookingPoortjieCircle = null;

  let trackingGoogleMap = null;
  let trackingDirectionsService = null;
  let trackingDirectionsRenderer = null;
  let trackingPickupMarker = null;
  let trackingDropoffMarker = null;
  let trackingDriverMarker = null;

  // Toast
  const toastEl = document.getElementById('toast');

  // Confirm Booking Modal Elements
  const confirmBookingModal = document.getElementById('confirm-booking-modal');
  const confirmBookingModalClose = document.getElementById('confirm-booking-modal-close');
  const confirmBookingBackBtn = document.getElementById('confirm-booking-back-btn');
  const confirmBookingSubmitBtn = document.getElementById('confirm-booking-submit-btn');
  const confirmPickupText = document.getElementById('confirm-pickup-text');
  const confirmDropoffText = document.getElementById('confirm-dropoff-text');
  const confirmTripType = document.getElementById('confirm-trip-type');
  const confirmDistanceText = document.getElementById('confirm-distance-text');
  const confirmNoteContainer = document.getElementById('confirm-note-container');
  const confirmNoteText = document.getElementById('confirm-note-text');
  const confirmModalError = document.getElementById('confirm-modal-error');

  // App Test / Beta Modal Elements
  const appTestModal = document.getElementById('app-test-modal');
  const appTestModalClose = document.getElementById('app-test-modal-close');
  const appTestModalCancel = document.getElementById('app-test-modal-cancel');
  const appTestDownloadBtn = document.getElementById('app-test-download-btn');

  // Gate Elements
  const termsGateView = document.getElementById('terms-gate-view');
  const termsAcceptCheckbox = document.getElementById('terms-accept-checkbox');
  const termsContinueBtn = document.getElementById('terms-continue-btn');
  const termsGateError = document.getElementById('terms-gate-error');

  const profileGateView = document.getElementById('profile-gate-view');
  const profileGateMissingList = document.getElementById('profile-gate-missing-list');
  const profileGateCompleteBtn = document.getElementById('profile-gate-complete-btn');

  // Dashboard Planned & Scheduled Cards
  const plannedRideCard = document.getElementById('planned-ride-card');
  const plannedCardBadge = document.getElementById('planned-card-badge');
  const plannedCardCount = document.getElementById('planned-card-count');
  const plannedCardDest = document.getElementById('planned-card-dest');
  const plannedCardSub = document.getElementById('planned-card-sub');
  const plannedCardRouteBox = document.getElementById('planned-card-route-box');
  const plannedCardFrom = document.getElementById('planned-card-from');
  const plannedCardTo = document.getElementById('planned-card-to');
  const plannedCardFare = document.getElementById('planned-card-fare');
  const plannedCardActionText = document.getElementById('planned-card-action-text');
  const plannedCardBtnTagAlong = document.getElementById('planned-card-btn-tagalong');
  const plannedCardBtnDeliver = document.getElementById('planned-card-btn-deliver');
  const plannedCardBtnFetch = document.getElementById('planned-card-btn-fetch');
  const plannedRideAppNudge = document.getElementById('planned-ride-app-nudge');

  const heroNameEl = document.getElementById('hero-name');
  const heroQuickCard = document.getElementById('hero-quick-card');

  const scheduledInviteCard = document.getElementById('scheduled-invite-card');
  const scheduledActiveCard = document.getElementById('scheduled-active-card');
  const scheduledCardDest = document.getElementById('scheduled-card-dest');
  const scheduledCardTime = document.getElementById('scheduled-card-time');
  const scheduledCardFare = document.getElementById('scheduled-card-fare');
  const scheduledStatusBadge = document.getElementById('scheduled-status-badge');
  const scheduledViewDetailsBtn = document.getElementById('scheduled-view-details-btn');

  // Schedule Modal Elements
  const scheduleModal = document.getElementById('schedule-modal');
  const scheduleModalClose = document.getElementById('schedule-modal-close');
  const scheduleModalCancel = document.getElementById('schedule-modal-cancel');
  const scheduleDateInput = document.getElementById('schedule-date-input');
  const scheduleTimeInput = document.getElementById('schedule-time-input');
  const schedulePickupInput = document.getElementById('schedule-pickup-input');
  const schedulePickupGpsBtn = document.getElementById('schedule-pickup-gps-btn');
  const scheduleDropoffInput = document.getElementById('schedule-dropoff-input');
  const scheduleTypeOneway = document.getElementById('schedule-type-oneway');
  const scheduleTypeReturn = document.getElementById('schedule-type-return');
  const scheduleReturnOptions = document.getElementById('schedule-return-options');
  const scheduleNotesInput = document.getElementById('schedule-notes-input');
  const scheduleFareBreakdown = document.getElementById('schedule-fare-breakdown');
  const scheduleFareAmount = document.getElementById('schedule-fare-amount');
  const scheduleModalError = document.getElementById('schedule-modal-error');
  const scheduleSubmitBtn = document.getElementById('schedule-submit-btn');

  // Planned Modal Elements
  const plannedModal = document.getElementById('planned-modal');
  const plannedModalClose = document.getElementById('planned-modal-close');
  const plannedModalDoneBtn = document.getElementById('planned-modal-done-btn');
  const plannedRidesList = document.getElementById('planned-rides-list');

  // Planned Reserve Modal Elements
  const plannedReserveModal = document.getElementById('planned-reserve-modal');
  const plannedReserveClose = document.getElementById('planned-reserve-close');
  const plannedReserveCancelBtn = document.getElementById('planned-reserve-cancel-btn');
  const plannedReserveSubmitBtn = document.getElementById('planned-reserve-submit-btn');
  const plannedReserveTitle = document.getElementById('planned-reserve-title');
  const plannedReserveSubtitle = document.getElementById('planned-reserve-subtitle');
  const plannedReserveBadge = document.getElementById('planned-reserve-badge');
  const plannedRoleToggleGroup = document.getElementById('planned-role-toggle-group');
  const plannedRolePassenger = document.getElementById('planned-role-passenger');
  const plannedRoleDeliver = document.getElementById('planned-role-deliver');
  const plannedRoleFetch = document.getElementById('planned-role-fetch');
  const plannedReserveDestHeader = document.getElementById('planned-reserve-dest-header');
  const plannedReserveTimeSeats = document.getElementById('planned-reserve-time-seats');
  const plannedReserveFromText = document.getElementById('planned-reserve-from-text');
  const plannedReserveToText = document.getElementById('planned-reserve-to-text');
  const plannedReserveFareLabel = document.getElementById('planned-reserve-fare-label');
  const plannedReserveFareDisplay = document.getElementById('planned-reserve-fare-display');
  const plannedReserveLocationLabel = document.getElementById('planned-reserve-location-label');
  const plannedReserveLocationHint = document.getElementById('planned-reserve-location-hint');
  const plannedReservePickupInput = document.getElementById('planned-reserve-pickup-input');
  const plannedReservePickupGpsBtn = document.getElementById('planned-reserve-pickup-gps-btn');
  const plannedReserveReturnWrap = document.getElementById('planned-reserve-return-wrap');
  const plannedReserveReturnCheckbox = document.getElementById('planned-reserve-return-checkbox');
  const plannedReserveReturnHint = document.getElementById('planned-reserve-return-hint');
  const plannedReserveNoteLabel = document.getElementById('planned-reserve-note-label');
  const plannedReserveNoteInput = document.getElementById('planned-reserve-note-input');
  const plannedReserveError = document.getElementById('planned-reserve-error');

  // Planned Booking Details Modal Elements
  const plannedBookingDetailsModal = document.getElementById('planned-booking-details-modal');
  const plannedBookingClose = document.getElementById('planned-booking-close');
  const plannedBookingDismissBtn = document.getElementById('planned-booking-dismiss-btn');
  const plannedBookingWithdrawBtn = document.getElementById('planned-booking-withdraw-btn');
  const plannedBookingStatusPill = document.getElementById('planned-booking-status-pill');
  const plannedBookingTime = document.getElementById('planned-booking-time');
  const plannedBookingPickup = document.getElementById('planned-booking-pickup');
  const plannedBookingDropoff = document.getElementById('planned-booking-dropoff');
  const plannedBookingFare = document.getElementById('planned-booking-fare');
  const plannedBookingDriverBox = document.getElementById('planned-booking-driver-box');
  const plannedBookingDriverPhoto = document.getElementById('planned-booking-driver-photo');
  const plannedBookingDriverName = document.getElementById('planned-booking-driver-name');
  const plannedBookingVehicle = document.getElementById('planned-booking-vehicle');
  const plannedBookingError = document.getElementById('planned-booking-error');

  // Scheduled Details Modal Elements
  const scheduledDetailsModal = document.getElementById('scheduled-details-modal');
  const scheduledDetailsClose = document.getElementById('scheduled-details-close');
  const scheduledDetailsDismiss = document.getElementById('scheduled-details-dismiss');
  const scheduledDetailsTime = document.getElementById('scheduled-details-time');
  const scheduledDetailsPickup = document.getElementById('scheduled-details-pickup');
  const scheduledDetailsDropoff = document.getElementById('scheduled-details-dropoff');
  const scheduledDetailsFare = document.getElementById('scheduled-details-fare');
  const scheduledDetailsStatusPill = document.getElementById('scheduled-details-status-pill');
  const scheduledDetailsDriverBox = document.getElementById('scheduled-details-driver-box');
  const scheduledDetailsDriverPhoto = document.getElementById('scheduled-details-driver-photo');
  const scheduledDetailsDriverName = document.getElementById('scheduled-details-driver-name');
  const scheduledDetailsVehicle = document.getElementById('scheduled-details-vehicle');
  const scheduledCancelBtn = document.getElementById('scheduled-cancel-btn');

  // Scheduled & Planned State
  let scheduledRidesEnabled = true;
  let appConfigUnsub = null;
  let activeScheduledUnsub = null;
  let currentScheduledDoc = null;
  let activePlannedListingsUnsub = null;
  let activePlannedRequestsUnsub = null;
  let availablePlannedPlans = [];
  let myPlannedRequests = [];
  let selectedPlannedRide = null;
  let selectedPlannedBooking = null;
  let selectedPlannedKind = 'PASSENGER';
  let reservePickupLocation = null;
  let scheduleState = {
    date: '',
    time: '',
    pickup: null,
    dropoff: null,
    tripType: 'ONE_WAY',
    returnWaitMinutes: 15,
    note: '',
    distanceKm: null,
    fare: null
  };

  /** Web Audio Chime Notification on Quote Received */
  function playQuoteChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + idx * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (idx + 1) * 0.14);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.08);
        osc.stop(ctx.currentTime + (idx + 1) * 0.14 + 0.1);
      });
    } catch (e) {
      console.warn('Audio chime playback:', e);
    }
  }

  /** Format Countdown Timer Text (Android spec: X m Y s or X s) */
  function formatTimerSeconds(seconds) {
    if (seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m > 0) {
      return `${m}m ${s}s`;
    }
    return `${s}s`;
  }

  /** Show toast message */
  function showToast(message, duration = 3500) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.remove('is-hidden');
    setTimeout(() => {
      toastEl.classList.add('is-hidden');
    }, duration);
  }

  /** Navigate user to global profile page */
  function navigateToProfile() {
    sessionStorage.setItem('redirectUrl', window.location.href);
    window.location.href = '../../authentication/profile';
  }

  /** Validate phone number: exactly 10 digits */
  function isValidPhone(phone) {
    if (!phone) return false;
    const clean = phone.toString().replace(/\D/g, '');
    return clean.length === 10;
  }

  /** Validate full name: 1 to 3 words */
  function isValidName(name) {
    if (!name) return false;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 64) return false;
    const parts = trimmed.split(/\s+/);
    return parts.length >= 1 && parts.length <= 3;
  }

  /** Haversine Distance in meters */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /** Geofence Validation: Must be within 175933m of Poortjie center */
  function isPickupAllowed(lat, lng) {
    if (lat == null || lng == null) return false;
    const dist = distanceMeters(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng, lat, lng);
    return dist <= SERVICE_AREA.radiusMeters;
  }

  /** Local area validation: Must be within 1637m of Poortjie local center to view driver fleet */
  function isWithinPoortjieLocalArea(lat, lng) {
    if (lat == null || lng == null) return false;
    const dist = distanceMeters(POORTJIE_LOCAL_AREA.center.lat, POORTJIE_LOCAL_AREA.center.lng, lat, lng);
    return dist <= POORTJIE_LOCAL_AREA.radiusMeters;
  }

  /** Calculate and update upfront fare preview card and submit button ONLY with actual driving road distance */
  function updateUpfrontFarePreview(overrideDistanceKm = null) {
    const vType = (bookingState.vehicleType || 'PRIVATE_CAR').toUpperCase();
    const rateInfo = activePricingRates[vType] || DEFAULT_PRICING_RATES[vType] || { ratePerKm: 10.0, minimumFare: 25.0, returnTripPercent: 80.0 };
    // Null / <= 0 curve scale means a straight line (no curve), i.e. linear pricing.
    const rateCurveScaleKm = (typeof rateInfo.curveScaleKm === 'number' && isFinite(rateInfo.curveScaleKm) && rateInfo.curveScaleKm > 0)
      ? rateInfo.curveScaleKm
      : null;

    const fareAmountEl = document.getElementById('booking-fare-amount') || document.getElementById('booking-distance-amount');
    const fareBreakdownEl = document.getElementById('booking-fare-breakdown') || document.getElementById('booking-distance-breakdown');
    const submitBtn = document.getElementById('booking-submit-btn');

    const hasPickupAddress = Boolean(bookingState.pickup && bookingState.pickup.address && bookingState.pickup.address.trim());
    const hasPickupCoords = Boolean(bookingState.pickup && typeof bookingState.pickup.lat === 'number' && typeof bookingState.pickup.lng === 'number' && !isNaN(bookingState.pickup.lat) && bookingState.pickup.lat !== 0);
    const hasDropoffAddress = Boolean(bookingState.dropoff && bookingState.dropoff.address && bookingState.dropoff.address.trim());
    const hasDropoffCoords = Boolean(bookingState.dropoff && typeof bookingState.dropoff.lat === 'number' && typeof bookingState.dropoff.lng === 'number' && !isNaN(bookingState.dropoff.lat) && bookingState.dropoff.lat !== 0);

    const hasPickup = hasPickupAddress && hasPickupCoords;
    const hasDropoff = hasDropoffAddress && hasDropoffCoords;

    if (overrideDistanceKm != null && typeof overrideDistanceKm === 'number' && !isNaN(overrideDistanceKm) && overrideDistanceKm > 0) {
      bookingState.actualOneWayDistanceKm = overrideDistanceKm;
    }

    if (!hasPickup || !hasDropoff) {
      bookingState.actualOneWayDistanceKm = null;
      bookingState.estimatedDistanceKm = null;
      bookingState.upfrontPrice = null;
      bookingState.ratePerKmSnapshot = rateInfo.ratePerKm;
      bookingState.minimumFareSnapshot = rateInfo.minimumFare;
      bookingState.curveScaleKmSnapshot = rateCurveScaleKm;
      bookingState.returnPercentSnapshot = bookingState.isReturnTrip !== false ? rateInfo.returnTripPercent : null;

      if (fareAmountEl) fareAmountEl.textContent = 'R --';
      if (fareBreakdownEl) {
        if (!hasPickup && !hasDropoff) {
          fareBreakdownEl.textContent = 'Enter pickup & destination to calculate fare';
        } else if (!hasPickup) {
          fareBreakdownEl.textContent = 'Enter pickup location';
        } else {
          fareBreakdownEl.textContent = 'Enter destination address';
        }
      }
      if (submitBtn) {
        submitBtn.innerHTML = '<span>⚡</span> Request Ride';
      }
      return;
    }

    // Both pickup & drop-off locations are set. Check if actual road distance has been computed.
    const oneWayDistKm = bookingState.actualOneWayDistanceKm;

    if (oneWayDistKm == null || isNaN(oneWayDistKm) || oneWayDistKm <= 0) {
      // Actual road distance is still being computed by Google Directions
      bookingState.estimatedDistanceKm = null;
      bookingState.upfrontPrice = null;
      bookingState.ratePerKmSnapshot = rateInfo.ratePerKm;
      bookingState.minimumFareSnapshot = rateInfo.minimumFare;
      bookingState.curveScaleKmSnapshot = rateCurveScaleKm;
      bookingState.returnPercentSnapshot = bookingState.isReturnTrip !== false ? rateInfo.returnTripPercent : null;

      if (fareAmountEl) fareAmountEl.textContent = 'R ...';
      if (fareBreakdownEl) {
        fareBreakdownEl.textContent = 'Calculating route distance & fare…';
      }
      if (submitBtn) {
        submitBtn.innerHTML = '<span>⚡</span> Calculating Route…';
      }
      return;
    }

    // We have the actual measured driving distance from Google Maps!
    const isReturn = bookingState.isReturnTrip !== false;
    const displayDistKm = isReturn ? (oneWayDistKm * 2.0) : oneWayDistKm;
    const returnPercent = typeof rateInfo.returnTripPercent === 'number' ? rateInfo.returnTripPercent : 80.0;
    // One-way basis with logarithmic distance curve. Null curve scale => linear.
    const distanceComponent = rateCurveScaleKm != null
      ? rateCurveScaleKm * Math.log(1 + oneWayDistKm / rateCurveScaleKm)
      : oneWayDistKm;
    const singlePrice = Math.max(rateInfo.minimumFare, rateInfo.ratePerKm * distanceComponent);

    let fare;
    if (isReturn) {
      const baseReturnPrice = singlePrice * (1.0 + returnPercent / 100.0);
      const waitMins = typeof bookingState.returnWaitMinutes === 'number' ? bookingState.returnWaitMinutes : 15;
      const freeMins = typeof rateInfo.freeWaitMinutes === 'number' ? rateInfo.freeWaitMinutes : 10;
      const ratePerMin = typeof rateInfo.waitRatePerMinute === 'number' ? rateInfo.waitRatePerMinute : 1.50;
      const chargeableMinutes = Math.max(0, waitMins - freeMins);
      const waitSurcharge = chargeableMinutes * ratePerMin;
      bookingState.waitPriceSnapshot = waitSurcharge;
      fare = Math.round(baseReturnPrice + waitSurcharge);
    } else {
      bookingState.waitPriceSnapshot = 0;
      fare = Math.round(singlePrice);
    }

    bookingState.estimatedDistanceKm = Number(displayDistKm.toFixed(1));
    bookingState.upfrontPrice = fare;
    bookingState.ratePerKmSnapshot = rateInfo.ratePerKm;
    bookingState.minimumFareSnapshot = rateInfo.minimumFare;
    bookingState.curveScaleKmSnapshot = rateCurveScaleKm;
    bookingState.returnPercentSnapshot = isReturn ? returnPercent : null;

    if (fareAmountEl) fareAmountEl.textContent = `R ${fare}`;
    if (fareBreakdownEl) {
      fareBreakdownEl.textContent = isReturn
        ? `~${bookingState.estimatedDistanceKm} km total (${oneWayDistKm.toFixed(1)} km return · ${bookingState.returnWaitMinutes || 15}m stop)`
        : `~${bookingState.estimatedDistanceKm} km (Single trip)`;
    }
    if (submitBtn) {
      submitBtn.innerHTML = `<span>⚡</span> Request Ride · R ${fare}`;
    }
  }

  // Alias for backward compatibility
  const updateBookingDistancePreview = updateUpfrontFarePreview;

  /** Listen for dynamic democratic pricing rates from Firestore */
  function initPricingRatesListener() {
    try {
      const pricingCol = db.collection(FS.laynfleet).doc(fleetEnvironment).collection('pricing');
      pricingCol.onSnapshot((snapshot) => {
        snapshot.forEach((doc) => {
          const data = doc.data() || {};
          const vType = (data.vehicleType || doc.id).toUpperCase();
          activePricingRates[vType] = {
            ratePerKm: typeof data.ratePerKm === 'number' ? data.ratePerKm : (DEFAULT_PRICING_RATES[vType]?.ratePerKm || 10.0),
            minimumFare: typeof data.minimumFare === 'number' ? data.minimumFare : (DEFAULT_PRICING_RATES[vType]?.minimumFare || 25.0),
            returnTripPercent: typeof data.returnTripPercent === 'number' ? data.returnTripPercent : (DEFAULT_PRICING_RATES[vType]?.returnTripPercent || 80.0),
            waitRatePerMinute: typeof data.waitRatePerMinute === 'number' ? data.waitRatePerMinute : (DEFAULT_PRICING_RATES[vType]?.waitRatePerMinute || 1.50),
            freeWaitMinutes: typeof data.freeWaitMinutes === 'number' ? data.freeWaitMinutes : (DEFAULT_PRICING_RATES[vType]?.freeWaitMinutes || 10),
            curveScaleKm: (typeof data.curveScaleKm === 'number' && isFinite(data.curveScaleKm) && data.curveScaleKm > 0) ? data.curveScaleKm : null
          };
        });
        updateUpfrontFarePreview();
      }, (err) => {
        console.warn('[LaynRider] Pricing rates listener warning:', err);
      });
    } catch (err) {
      console.warn('[LaynRider] Failed to init pricing rates listener:', err);
    }
  }

  const CONSENT_REVISION = '2026-11-16';

  /** Check LaynFleet Terms & Privacy consent (mirrors Android FirestoreConsentRepository) */
  async function checkLaynFleetConsent(uid) {
    if (!uid) return false;
    try {
      const snap = await db.collection('laynfleet').doc(fleetEnvironment).collection('riders').doc(uid).get({ source: 'server' });
      if (!snap.exists) return false;
      const data = snap.data() || {};
      const consent = data.laynFleetConsent;
      return Boolean(
        consent &&
        consent.termsVersion === CONSENT_REVISION &&
        consent.privacyVersion === CONSENT_REVISION &&
        consent.acceptedAt
      );
    } catch (e) {
      console.warn('[LaynRider] Failed to verify consent status:', e);
      return false;
    }
  }

  /** Persist LaynFleet Terms & Privacy consent acceptance */
  async function saveLaynFleetConsent(uid) {
    if (!uid) throw new Error('Sign in required');
    await db.collection('laynfleet').doc(fleetEnvironment).collection('riders').doc(uid).set({
      uid: uid,
      laynFleetConsent: {
        termsVersion: CONSENT_REVISION,
        privacyVersion: CONSENT_REVISION,
        acceptedAt: firebase.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });
  }

  /** Evaluate profile completeness strictly against Android RiderProfileRequirements */
  function checkProfileCompleteness(data, authRecord) {
    if (!data) data = {};
    if (!authRecord) authRecord = {};
    const name = (data.displayName || data.fullName || authRecord.displayName || '').trim();
    const phone = (data.phone || authRecord.phoneNumber || '').replace(/\D/g, '');
    const photo = (data.photoUrl || authRecord.photoURL || '').trim();

    const nameOk = isValidName(name);
    const phoneOk = isValidPhone(phone);
    const photoOk = Boolean(photo && photo.length > 0);

    const missing = [];
    if (!nameOk) missing.push({ id: 'name', label: 'Full name (1–3 words, letters only)' });
    if (!phoneOk) missing.push({ id: 'phone', label: 'Phone number (10 digits)' });
    if (!photoOk) missing.push({ id: 'photo', label: 'Profile photo' });

    return {
      isComplete: missing.length === 0,
      missing,
      name,
      phone,
      photo,
      nameOk,
      phoneOk,
      photoOk
    };
  }

  /** Render missing profile details on the dashboard gate */
  function renderMissingProfileDetails(missingList) {
    if (!profileGateMissingList) return;
    profileGateMissingList.innerHTML = '';
    (missingList || []).forEach(item => {
      const li = document.createElement('li');
      li.className = 'profile-gate-item is-missing';
      li.textContent = item.label;
      profileGateMissingList.appendChild(li);
    });
  }

  /** Navigate user to global Poortjie profile page */
  function navigateToProfile() {
    sessionStorage.setItem('redirectUrl', window.location.href);
    window.location.href = '../../authentication/profile';
  }

  /** ============================================================
   * SCHEDULED RIDES (SCHEDULE A RIDE / YOUR RIDES)
   * ============================================================ */

  function initScheduledRidesListener(uid) {
    if (!uid) return;
    if (activeScheduledUnsub) { activeScheduledUnsub(); activeScheduledUnsub = null; }

    try {
      const scheduledCol = db.collection('laynfleet').doc(fleetEnvironment)
        .collection('scheduledRequests').doc(uid).collection('requests');

      activeScheduledUnsub = scheduledCol.onSnapshot((snap) => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(d => !['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(d.status));

        if (list.length > 0) {
          list.sort((a, b) => (readEpochMillis(a.scheduledTime) || 0) - (readEpochMillis(b.scheduledTime) || 0));
          currentScheduledDoc = list[0];
          renderActiveScheduledCard(currentScheduledDoc, list.length);
        } else {
          currentScheduledDoc = null;
          if (scheduledActiveCard) scheduledActiveCard.classList.add('is-hidden');
          if (scheduledInviteCard) scheduledInviteCard.classList.toggle('is-hidden', !scheduledRidesEnabled);
        }
      }, (err) => {
        console.warn('[LaynRider] Scheduled requests listener warning:', err);
      });
    } catch (e) {
      console.warn('[LaynRider] Failed to init scheduled requests listener:', e);
    }
  }

  function updateScheduledRidesVisibility() {
    if (!currentScheduledDoc && scheduledInviteCard) {
      scheduledInviteCard.classList.toggle('is-hidden', !scheduledRidesEnabled);
    }
    if (bookingScheduleBtn) {
      bookingScheduleBtn.classList.toggle('is-hidden', !scheduledRidesEnabled);
    }
  }

  /** Listen for feature toggles from appConfig/laynrider */
  function initAppConfigListener() {
    if (appConfigUnsub) { appConfigUnsub(); appConfigUnsub = null; }
    try {
      const configDoc = db.collection(FS.laynfleet).doc(fleetEnvironment).collection('appConfig').doc('laynrider');
      appConfigUnsub = configDoc.onSnapshot((snapshot) => {
        const data = snapshot.exists ? (snapshot.data() || {}) : {};
        // Owner decision: default to true if omitted, null, or on error
        scheduledRidesEnabled = data.scheduledRidesEnabled !== false;
        updateScheduledRidesVisibility();
      }, (err) => {
        console.warn('[LaynRider] appConfig listener warning:', err);
        scheduledRidesEnabled = true;
        updateScheduledRidesVisibility();
      });
    } catch (err) {
      console.warn('[LaynRider] Failed to init appConfig listener:', err);
      scheduledRidesEnabled = true;
      updateScheduledRidesVisibility();
    }
  }

  function renderActiveScheduledCard(booking, count) {
    if (!booking) return;
    if (scheduledInviteCard) scheduledInviteCard.classList.add('is-hidden');
    if (scheduledActiveCard) scheduledActiveCard.classList.remove('is-hidden');

    const dest = (booking.dropoff && booking.dropoff.address) || booking.destination || 'Scheduled Destination';
    const cleanDest = dest.split(',')[0];
    if (scheduledCardDest) scheduledCardDest.textContent = cleanDest;

    const epoch = readEpochMillis(booking.scheduledTime) || Date.now();
    const dateObj = new Date(epoch);
    const timeStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' +
                    dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (scheduledCardTime) scheduledCardTime.textContent = 'Scheduled for ' + timeStr;

    const fare = booking.fare || booking.upfrontPrice;
    if (scheduledCardFare) {
      scheduledCardFare.textContent = typeof fare === 'number' ? 'R ' + Math.round(fare) : 'R --';
    }

    if (scheduledStatusBadge) {
      const st = (booking.status || 'PENDING').toUpperCase();
      let badgeText = st;
      if (st === 'PENDING') badgeText = 'SEARCHING';
      else if (st === 'UNDER_REVIEW') badgeText = 'REVIEWING';
      else if (st === 'SCHEDULED_CONFIRMED') badgeText = 'CONFIRMED';
      scheduledStatusBadge.textContent = badgeText;
    }
  }

  function openScheduleModal() {
    if (!scheduledRidesEnabled) {
      showToast('Scheduled ride creation is currently disabled.');
      return;
    }
    if (!isProfileComplete) {
      showToast('Please complete your profile to schedule a ride.');
      navigateToProfile();
      return;
    }
    if (scheduleModalError) scheduleModalError.classList.add('is-hidden');

    // Default date to today, time to now + 45 min
    const now = new Date(Date.now() + 45 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const dateVal = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timeVal = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    if (scheduleDateInput) {
      scheduleDateInput.min = dateVal;
      scheduleDateInput.value = dateVal;
    }
    if (scheduleTimeInput) scheduleTimeInput.value = timeVal;

    scheduleState = {
      date: dateVal,
      time: timeVal,
      pickup: bookingState.pickup.address ? { ...bookingState.pickup } : null,
      dropoff: bookingState.dropoff.address ? { ...bookingState.dropoff } : null,
      tripType: 'ONE_WAY',
      returnWaitMinutes: 15,
      note: '',
      distanceKm: null,
      fare: null
    };

    if (schedulePickupInput) schedulePickupInput.value = scheduleState.pickup?.address || '';
    if (scheduleDropoffInput) scheduleDropoffInput.value = scheduleState.dropoff?.address || '';
    updateScheduleFareEstimate();

    if (scheduleModal) scheduleModal.classList.remove('is-hidden');
  }

  function closeScheduleModal() {
    if (scheduleModal) scheduleModal.classList.add('is-hidden');
  }

  function updateScheduleFareEstimate() {
    if (!scheduleState.pickup || !scheduleState.dropoff || !global.google || !global.google.maps) {
      if (scheduleFareAmount) scheduleFareAmount.textContent = 'R --';
      if (scheduleFareBreakdown) scheduleFareBreakdown.textContent = 'Enter pickup & destination to calculate fare';
      return;
    }

    const service = new google.maps.DistanceMatrixService();
    service.getDistanceMatrix({
      origins: [new google.maps.LatLng(scheduleState.pickup.lat, scheduleState.pickup.lng)],
      destinations: [new google.maps.LatLng(scheduleState.dropoff.lat, scheduleState.dropoff.lng)],
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.METRIC
    }, (response, status) => {
      if (status === 'OK' && response.rows[0]?.elements[0]?.status === 'OK') {
        const elem = response.rows[0].elements[0];
        const distKm = elem.distance.value / 1000;
        scheduleState.distanceKm = distKm;
        scheduleState.durationSeconds = elem.duration ? Math.round(elem.duration.value) : Math.round((distKm / 40) * 3600);

        const rateObj = activePricingRates['PRIVATE_CAR'] || DEFAULT_PRICING_RATES['PRIVATE_CAR'];
        const isReturn = scheduleState.tripType === 'RETURN';
        let fare = rateObj.ratePerKm * distKm;
        if (fare < rateObj.minimumFare) fare = rateObj.minimumFare;
        if (isReturn) {
          fare = fare * (1 + (rateObj.returnTripPercent || 80) / 100);
          fare += (rateObj.waitRatePerMinute || 1.5) * (scheduleState.returnWaitMinutes || 15);
        }
        scheduleState.fare = Math.round(fare);

        if (scheduleFareAmount) scheduleFareAmount.textContent = 'R ' + scheduleState.fare;
        if (scheduleFareBreakdown) {
          scheduleFareBreakdown.textContent = `~${distKm.toFixed(1)} km · ${isReturn ? 'Return Trip' : 'One-Way'}`;
        }
      }
    });
  }

  async function handleScheduleSubmit() {
    if (!currentUser) return;
    if (!scheduledRidesEnabled) {
      if (scheduleModalError) {
        scheduleModalError.textContent = 'Scheduled ride creation is currently disabled.';
        scheduleModalError.classList.remove('is-hidden');
      }
      return;
    }
    if (scheduleModalError) scheduleModalError.classList.add('is-hidden');

    const dateVal = scheduleDateInput?.value;
    const timeVal = scheduleTimeInput?.value;
    if (!dateVal || !timeVal) {
      if (scheduleModalError) {
        scheduleModalError.textContent = 'Please select a valid date and time.';
        scheduleModalError.classList.remove('is-hidden');
      }
      return;
    }

    const scheduledDate = new Date(`${dateVal}T${timeVal}`);
    const scheduledEpoch = scheduledDate.getTime();
    const minEpoch = Date.now() + 25 * 60 * 1000; // at least 25-30 min lead time
    if (isNaN(scheduledEpoch) || scheduledEpoch < minEpoch) {
      if (scheduleModalError) {
        scheduleModalError.textContent = 'Rides must be scheduled at least 30 minutes in advance.';
        scheduleModalError.classList.remove('is-hidden');
      }
      return;
    }

    if (!scheduleState.pickup || !scheduleState.pickup.lat) {
      if (scheduleModalError) {
        scheduleModalError.textContent = 'Please enter a valid pickup address within the service area.';
        scheduleModalError.classList.remove('is-hidden');
      }
      return;
    }

    if (!scheduleState.dropoff || !scheduleState.dropoff.lat) {
      if (scheduleModalError) {
        scheduleModalError.textContent = 'Please enter a valid destination address.';
        scheduleModalError.classList.remove('is-hidden');
      }
      return;
    }

    try {
      if (scheduleSubmitBtn) {
        scheduleSubmitBtn.disabled = true;
        scheduleSubmitBtn.innerHTML = '<div class="spinner"></div> Scheduling…';
      }

      const token = await currentUser.getIdToken();
      const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sched_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));
      const isReturn = scheduleState.tripType === 'RETURN';
      const note = (scheduleNotesInput?.value || '').trim().substring(0, 64);
      const vehicleType = 'PRIVATE_CAR';
      const pricingSnapshot = getPricingSnapshot(vehicleType);

      const pickup = {
        address: scheduleState.pickup.address || '',
        lat: Number(scheduleState.pickup.lat),
        lng: Number(scheduleState.pickup.lng)
      };
      const dropoff = {
        address: scheduleState.dropoff.address || '',
        lat: Number(scheduleState.dropoff.lat),
        lng: Number(scheduleState.dropoff.lng)
      };

      const fare = Number(scheduleState.fare || pricingSnapshot.minimumFare);
      const distanceKm = Number(scheduleState.distanceKm || 1);
      const durationSeconds = Math.round(Number(scheduleState.durationSeconds || ((distanceKm / 40) * 3600) || 600));

      const payload = {
        requestId,
        pickup,
        dropoff,
        vehicleType,
        note,
        isReturnRide: isReturn,
        returnWaitMinutes: isReturn ? (Number(scheduleState.returnWaitMinutes) || 15) : null,
        scheduledTime: scheduledEpoch,
        fare: Math.max(fare, pricingSnapshot.minimumFare),
        distanceKm: Math.max(distanceKm, 0.1),
        durationSeconds: Math.max(durationSeconds, 60),
        pricingSnapshot
      };

      const resp = await fetch('https://api.digilayn.co.za/scheduled-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Layn-App': 'laynrider',
          'X-Layn-Environment': fleetEnvironment
        },
        body: JSON.stringify(payload)
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (json && json.error && (json.error.message || json.error.code)) || 'Could not schedule ride.';
        throw new Error(msg);
      }

      closeScheduleModal();
      showToast('📅 Ride scheduled successfully!');
    } catch (err) {
      console.error('[LaynRider] Failed to schedule ride:', err);
      if (scheduleModalError) {
        scheduleModalError.textContent = err.message || 'Could not schedule ride. Please try again.';
        scheduleModalError.classList.remove('is-hidden');
      }
    } finally {
      if (scheduleSubmitBtn) {
        scheduleSubmitBtn.disabled = false;
        scheduleSubmitBtn.innerHTML = '<span>📅</span> Schedule Ride';
      }
    }
  }

  function openScheduledDetailsModal() {
    if (!currentScheduledDoc) return;
    const b = currentScheduledDoc;

    if (scheduledDetailsTime) {
      const epoch = readEpochMillis(b.scheduledTime) || Date.now();
      const d = new Date(epoch);
      scheduledDetailsTime.textContent = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
        ' at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    if (scheduledDetailsPickup) {
      scheduledDetailsPickup.textContent = (b.pickup && b.pickup.address) || '—';
    }
    if (scheduledDetailsDropoff) {
      scheduledDetailsDropoff.textContent = (b.dropoff && b.dropoff.address) || b.destination || '—';
    }
    if (scheduledDetailsFare) {
      const fare = b.fare || b.upfrontPrice;
      scheduledDetailsFare.textContent = typeof fare === 'number' ? 'R ' + Math.round(fare) : 'R --';
    }
    if (scheduledDetailsStatusPill) {
      const st = (b.status || 'PENDING').toUpperCase();
      scheduledDetailsStatusPill.textContent = st === 'PENDING' ? 'SEARCHING' : st;
    }

    if (b.driverName && scheduledDetailsDriverBox) {
      scheduledDetailsDriverBox.classList.remove('is-hidden');
      if (scheduledDetailsDriverName) scheduledDetailsDriverName.textContent = b.driverName;
      if (scheduledDetailsVehicle) scheduledDetailsVehicle.textContent = b.driverVehicle || 'Assigned Driver';
      if (scheduledDetailsDriverPhoto) {
        scheduledDetailsDriverPhoto.src = b.driverPhotoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(b.driverName)}&background=22c55e&color=fff&size=120`;
      }
    } else if (scheduledDetailsDriverBox) {
      scheduledDetailsDriverBox.classList.add('is-hidden');
    }

    if (scheduledDetailsModal) scheduledDetailsModal.classList.remove('is-hidden');
  }

  function closeScheduledDetailsModal() {
    if (scheduledDetailsModal) scheduledDetailsModal.classList.add('is-hidden');
  }

  async function handleCancelScheduledRide() {
    if (!currentScheduledDoc || !currentUser) return;
    const confirmCancel = window.confirm('Are you sure you want to cancel this scheduled ride?');
    if (!confirmCancel) return;

    try {
      if (scheduledCancelBtn) scheduledCancelBtn.disabled = true;
      const token = await currentUser.getIdToken();
      const actionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('act_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));

      const resp = await fetch(`https://api.digilayn.co.za/scheduled-requests/${currentScheduledDoc.id}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Layn-App': 'laynrider',
          'X-Layn-Environment': fleetEnvironment
        },
        body: JSON.stringify({ actionId, reason: 'Cancelled by rider' })
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (json && json.error && (json.error.message || json.error.code)) || 'Failed to cancel scheduled ride.';
        throw new Error(msg);
      }

      showToast('Scheduled ride cancelled.');
      closeScheduledDetailsModal();
    } catch (e) {
      console.error('[LaynRider] Failed to cancel scheduled ride:', e);
      showToast('Failed to cancel. Please try again.');
    } finally {
      if (scheduledCancelBtn) scheduledCancelBtn.disabled = false;
    }
  }

  /** ============================================================
   * PLANNED RIDES (TAG ALONG & COMMUNITY ERRANDS)
   * ============================================================ */

  let plannedReserveAutocomplete = null;

  function formatDepartureDateTime(epoch) {
    if (!epoch) return '--:--';
    const d = new Date(epoch);
    const dateFormatted = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const timeFormatted = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${dateFormatted} at ${timeFormatted}`;
  }

  function ensurePlannedReserveAutocomplete() {
    if (plannedReserveAutocomplete || !plannedReservePickupInput || !global.google || !global.google.maps || !global.google.maps.places) return;
    const poortjieCenter = new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
    const circle = new google.maps.Circle({ center: poortjieCenter, radius: SERVICE_AREA.radiusMeters });
    plannedReserveAutocomplete = new google.maps.places.Autocomplete(plannedReservePickupInput, {
      bounds: circle.getBounds(),
      componentRestrictions: { country: 'za' },
      fields: ['formatted_address', 'name', 'geometry']
    });
    plannedReserveAutocomplete.addListener('place_changed', () => {
      const place = plannedReserveAutocomplete.getPlace();
      if (place && place.geometry && place.geometry.location) {
        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        const addr = place.formatted_address || place.name || plannedReservePickupInput.value;
        reservePickupLocation = { address: addr, lat, lng };
        plannedReservePickupInput.value = addr;
        if (plannedReserveError) plannedReserveError.classList.add('is-hidden');
      }
    });
  }

  function initPlannedRidesListener(uid) {
    if (activePlannedListingsUnsub) { activePlannedListingsUnsub(); activePlannedListingsUnsub = null; }
    if (activePlannedRequestsUnsub) { activePlannedRequestsUnsub(); activePlannedRequestsUnsub = null; }

    // 1. Rider's own booked planned requests (participating rides, matching Android Dataset.PLANNED_REQUESTS)
    if (uid) {
      try {
        const myRequestsCol = db.collection('laynfleet').doc(fleetEnvironment)
          .collection('plannedRideRequests').doc(uid).collection('requests');

        activePlannedRequestsUnsub = myRequestsCol.onSnapshot((snap) => {
          myPlannedRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(d => !['COMPLETED', 'CANCELLED', 'REJECTED', 'WITHDRAWN'].includes(d.status))
            .sort((a, b) => (readEpochMillis(a.departure || a.startAt) || 0) - (readEpochMillis(b.departure || b.startAt) || 0));
          updatePlannedRideDisplay();
        }, (err) => {
          console.warn('[LaynRider] My planned requests listener warning:', err);
          myPlannedRequests = [];
          updatePlannedRideDisplay();
        });
      } catch (e) {
        console.warn('[LaynRider] Failed to init my planned requests listener:', e);
        myPlannedRequests = [];
      }
    } else {
      myPlannedRequests = [];
    }

    // 2. Open community planned rides published by drivers (matching Android Dataset.AVAILABLE_PLANS)
    try {
      const plannedQuery = db.collectionGroup('requests')
        .where('environment', '==', fleetEnvironment)
        .where('recordType', '==', 'plannedRideListings')
        .where('status', '==', 'OPEN');

      activePlannedListingsUnsub = plannedQuery.onSnapshot((snap) => {
        const now = Date.now();
        availablePlannedPlans = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(p => {
            const epoch = readEpochMillis(p.startAt || p.departure);
            // Must not be expired: departure + 5 min must be > now (matches Android)
            return epoch && (epoch + 5 * 60 * 1000 > now);
          })
          .sort((a, b) => (readEpochMillis(a.startAt || a.departure) || 0) - (readEpochMillis(b.startAt || b.departure) || 0));
        updatePlannedRideDisplay();
      }, (err) => {
        console.warn('[LaynRider] Planned ride listings listener warning:', err);
        availablePlannedPlans = [];
        updatePlannedRideDisplay();
      });
    } catch (e) {
      console.warn('[LaynRider] Failed to init planned ride listings listener:', e);
      availablePlannedPlans = [];
      updatePlannedRideDisplay();
    }
  }

  function updatePlannedRideDisplay() {
    if (!plannedRideCard) return;

    // Filter community plans: exclude plans where rider is already participating
    const unbookedCommunityPlans = availablePlannedPlans.filter(p =>
      !myPlannedRequests.some(r => r.planId === p.id || r.id === p.id)
    );

    // Matching Android priority (RiderDashboardScreen.kt):
    // 1. If participating in a planned ride, show rider's booked plan first
    if (myPlannedRequests.length > 0) {
      const req = myPlannedRequests[0];
      const dest = (req.destination && req.destination.address) || req.destination || '';
      const cleanDest = typeof dest === 'string' ? dest.split(',')[0].trim() : 'Destination';
      if (plannedCardDest) plannedCardDest.textContent = `Going to "${cleanDest}"`;

      const epoch = readEpochMillis(req.departure || req.startAt);
      const timeStr = formatDepartureDateTime(epoch);
      const statusLabel = req.status === 'ACCEPTED' ? 'Confirmed' : (req.status || 'Booked');
      if (plannedCardSub) plannedCardSub.textContent = epoch ? `Departs ${timeStr} · ${statusLabel}` : statusLabel;

      const fullPickup = (req.pickup && req.pickup.address) || req.pickup || 'Pick-up Location';
      const fullDest = dest || '—';
      if (plannedCardFrom) plannedCardFrom.textContent = `📍 From: ${fullPickup}`;
      if (plannedCardTo) plannedCardTo.textContent = `🎯 To: ${fullDest}`;

      const fare = req.fare || req.oneWayFare;
      if (plannedCardFare) plannedCardFare.textContent = typeof fare === 'number' ? `R ${Math.round(fare)}` : '';

      const kindLabel = req.kind === 'DELIVER' ? 'DELIVERY' : (req.kind === 'FETCH' ? 'FETCH ERRAND' : 'TAG ALONG');
      if (plannedCardBadge) plannedCardBadge.textContent = `${kindLabel} · ${statusLabel.toUpperCase()}`;
      if (plannedCardCount) {
        plannedCardCount.textContent = `${myPlannedRequests.length} booked`;
        plannedCardCount.classList.remove('is-hidden');
      }

      if (plannedCardBtnTagAlong) plannedCardBtnTagAlong.classList.add('is-hidden');
      if (plannedCardBtnDeliver) plannedCardBtnDeliver.classList.add('is-hidden');
      if (plannedCardBtnFetch) plannedCardBtnFetch.classList.add('is-hidden');
      if (plannedCardActionText) {
        plannedCardActionText.textContent = 'View Booking ➔';
        plannedCardActionText.classList.remove('is-hidden');
      }

      plannedRideCard.classList.remove('is-hidden');
      if (plannedRideAppNudge) plannedRideAppNudge.classList.remove('is-hidden');
    } else if (unbookedCommunityPlans.length > 0) {
      // 2. Otherwise show earliest available community plan from drivers
      const plan = unbookedCommunityPlans[0];
      const dest = (plan.destination && plan.destination.address) || plan.destination || '';
      const cleanDest = typeof dest === 'string' ? dest.split(',')[0].trim() : 'Destination';
      if (plannedCardDest) plannedCardDest.textContent = `Going to "${cleanDest}"`;

      const epoch = readEpochMillis(plan.startAt || plan.departure);
      const timeStr = formatDepartureDateTime(epoch);
      const seats = plan.availablePlaces ?? plan.seats ?? 0;
      if (plannedCardSub) plannedCardSub.textContent = epoch ? `Departs ${timeStr} · ${seats} seats available` : `${seats} seats available`;

      const fullPickup = (plan.pickup && plan.pickup.address) || plan.pickup || 'Pick-up Location';
      const fullDest = dest || '—';
      if (plannedCardFrom) plannedCardFrom.textContent = `📍 From: ${fullPickup}`;
      if (plannedCardTo) plannedCardTo.textContent = `🎯 To: ${fullDest}`;

      const fare = plan.oneWayFare ?? plan.fare;
      if (plannedCardFare) plannedCardFare.textContent = typeof fare === 'number' ? `R ${Math.round(fare)}` : '';
      if (plannedCardBadge) plannedCardBadge.textContent = seats <= 0 ? 'ERRANDS ONLY' : 'TAG ALONG';
      if (plannedCardCount) {
        plannedCardCount.textContent = `1 of ${unbookedCommunityPlans.length}`;
        plannedCardCount.classList.remove('is-hidden');
      }

      // Show Tag Along, Deliver, Fetch action buttons on card matching Android
      if (plannedCardBtnTagAlong) {
        if (seats > 0) plannedCardBtnTagAlong.classList.remove('is-hidden');
        else plannedCardBtnTagAlong.classList.add('is-hidden');
      }
      if (plannedCardBtnDeliver) {
        if (plan.allowErrands) plannedCardBtnDeliver.classList.remove('is-hidden');
        else plannedCardBtnDeliver.classList.add('is-hidden');
      }
      if (plannedCardBtnFetch) {
        if (plan.allowErrands && plan.isReturnRide) plannedCardBtnFetch.classList.remove('is-hidden');
        else plannedCardBtnFetch.classList.add('is-hidden');
      }
      if (plannedCardActionText) plannedCardActionText.classList.add('is-hidden');

      plannedRideCard.classList.remove('is-hidden');
      if (plannedRideAppNudge) plannedRideAppNudge.classList.remove('is-hidden');
    } else {
      // 3. Otherwise hide the card and app nudge completely
      if (plannedCardDest) plannedCardDest.textContent = '';
      if (plannedCardSub) plannedCardSub.textContent = '';
      if (plannedCardFare) plannedCardFare.textContent = '';
      if (plannedCardCount) plannedCardCount.classList.add('is-hidden');
      plannedRideCard.classList.add('is-hidden');
      if (plannedRideAppNudge) plannedRideAppNudge.classList.add('is-hidden');
    }
  }

  function openPlannedModal() {
    if (plannedRidesList) {
      plannedRidesList.innerHTML = '';

      if (myPlannedRequests.length > 0) {
        myPlannedRequests.forEach(req => {
          const item = document.createElement('div');
          item.className = 'dashboard-card';
          item.style.padding = '12px 16px';
          item.style.marginBottom = '8px';
          item.style.borderColor = 'var(--digilayn-primary)';
          item.style.cursor = 'pointer';

          const dest = (req.destination && req.destination.address) || req.destination || 'Destination';
          const cleanDest = typeof dest === 'string' ? dest.split(',')[0].trim() : 'Destination';
          const epoch = readEpochMillis(req.departure || req.startAt);
          const timeStr = epoch ? new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
          const fare = req.fare || req.oneWayFare;
          const fareStr = typeof fare === 'number' ? `R ${Math.round(fare)}` : 'R --';
          const status = req.status === 'ACCEPTED' ? 'CONFIRMED' : (req.status || 'BOOKED');
          const kindLabel = req.kind === 'DELIVER' ? 'DELIVERY' : (req.kind === 'FETCH' ? 'FETCH ERRAND' : 'TAG ALONG');

          item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div>
                <span class="badge-pill badge-planned" style="font-size: 10px; margin-bottom: 4px; display: inline-block;">${kindLabel} · ${status}</span>
                <strong style="font-size: 15px; color: var(--digilayn-on-surface); display: block;">Going to "${cleanDest}"</strong>
                <p style="font-size: 12.5px; color: var(--digilayn-on-surface-variant); margin: 2px 0 0 0;">Departs ${timeStr}</p>
              </div>
              <span class="planned-fare-tag">${fareStr}</span>
            </div>
            <p style="font-size: 12px; color: var(--digilayn-primary); font-weight: 700; margin-top: 6px;">Tap to view booking details ➔</p>
          `;
          item.addEventListener('click', () => {
            closePlannedModal();
            openPlannedBookingDetailsModal(req);
          });
          plannedRidesList.appendChild(item);
        });
      }

      const unbookedCommunityPlans = availablePlannedPlans.filter(p =>
        !myPlannedRequests.some(r => r.planId === p.id || r.id === p.id)
      );

      if (unbookedCommunityPlans.length > 0) {
        unbookedCommunityPlans.forEach(plan => {
          const item = document.createElement('div');
          item.className = 'dashboard-card';
          item.style.padding = '12px 16px';
          item.style.marginBottom = '8px';

          const dest = (plan.destination && plan.destination.address) || plan.destination || 'Destination';
          const cleanDest = typeof dest === 'string' ? dest.split(',')[0].trim() : 'Destination';
          const epoch = readEpochMillis(plan.startAt || plan.departure);
          const timeStr = formatDepartureDateTime(epoch);
          const seats = plan.availablePlaces ?? plan.seats ?? 0;
          const fare = plan.oneWayFare ?? plan.fare;
          const fareStr = typeof fare === 'number' ? `R ${Math.round(fare)}` : 'R --';

          item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
              <div>
                <strong style="font-size: 15px; color: var(--digilayn-on-surface); display: block;">Going to "${cleanDest}"</strong>
                <p style="font-size: 12.5px; color: var(--digilayn-on-surface-variant); margin: 2px 0 0 0;">Departs ${timeStr} · ${seats} seats left</p>
              </div>
              <span class="planned-fare-tag">${fareStr}</span>
            </div>
            <div style="display: flex; gap: 6px; align-items: center; justify-content: flex-end; margin-top: 10px;">
              ${seats > 0 ? '<button type="button" class="btn btn-sm btn-primary modal-action-btn" data-kind="PASSENGER" style="padding: 4px 10px; font-size: 11.5px;">🧑 Tag Along</button>' : ''}
              ${plan.allowErrands ? '<button type="button" class="btn btn-sm btn-ghost modal-action-btn" data-kind="DELIVER" style="padding: 4px 10px; font-size: 11.5px;">📦 Deliver</button>' : ''}
              ${plan.allowErrands && plan.isReturnRide ? '<button type="button" class="btn btn-sm btn-ghost modal-action-btn" data-kind="FETCH" style="padding: 4px 10px; font-size: 11.5px;">🛍️ Fetch</button>' : ''}
            </div>
          `;
          const buttons = item.querySelectorAll('.modal-action-btn');
          buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              closePlannedModal();
              openPlannedReserveModal(plan, btn.getAttribute('data-kind'));
            });
          });
          item.addEventListener('click', () => {
            closePlannedModal();
            openPlannedReserveModal(plan, seats > 0 ? 'PASSENGER' : 'DELIVER');
          });
          plannedRidesList.appendChild(item);
        });
      }

      if (myPlannedRequests.length === 0 && unbookedCommunityPlans.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.style.padding = '16px';
        placeholder.style.textAlign = 'center';
        placeholder.style.color = 'var(--digilayn-on-surface-variant)';
        placeholder.style.fontSize = '13px';
        placeholder.innerHTML = '<strong>No departures scheduled right now.</strong><p style="margin-top: 4px;">Drivers post upcoming Tag Along routes here regularly. Check back soon!</p>';
        plannedRidesList.appendChild(placeholder);
      }
    }
    if (plannedModal) plannedModal.classList.remove('is-hidden');
  }

  function closePlannedModal() {
    if (plannedModal) plannedModal.classList.add('is-hidden');
  }

  function selectPlannedRole(kind) {
    selectedPlannedKind = kind;
    if (plannedRolePassenger) {
      if (kind === 'PASSENGER') plannedRolePassenger.className = 'btn btn-sm btn-primary';
      else plannedRolePassenger.className = 'btn btn-sm btn-ghost';
    }
    if (plannedRoleDeliver) {
      if (kind === 'DELIVER') plannedRoleDeliver.className = 'btn btn-sm btn-primary';
      else plannedRoleDeliver.className = 'btn btn-sm btn-ghost';
    }
    if (plannedRoleFetch) {
      if (kind === 'FETCH') plannedRoleFetch.className = 'btn btn-sm btn-primary';
      else plannedRoleFetch.className = 'btn btn-sm btn-ghost';
    }

    if (!selectedPlannedRide) return;
    const plan = selectedPlannedRide;
    const dest = (plan.destination && plan.destination.address) || plan.destination || '';
    const cleanDest = typeof dest === 'string' ? dest.split(',')[0].trim() : 'Destination';
    const fullPickup = (plan.pickup && plan.pickup.address) || plan.pickup || 'Pick-up Location';
    const oneWayFare = plan.oneWayFare ?? plan.fare ?? 0;
    const returnFare = plan.returnFare ?? (oneWayFare * 2);

    if (kind === 'PASSENGER') {
      if (plannedReserveTitle) plannedReserveTitle.textContent = 'Reserve a Seat';
      if (plannedReserveSubtitle) plannedReserveSubtitle.textContent = 'Tag Along Community Route';
      if (plannedReserveBadge) plannedReserveBadge.textContent = 'TAG ALONG ROUTE';
      if (plannedReserveFareLabel) plannedReserveFareLabel.textContent = 'Seat Fare:';
      if (plannedReserveLocationLabel) plannedReserveLocationLabel.innerHTML = 'Your Pickup Location';
      if (plannedReserveLocationHint) plannedReserveLocationHint.textContent = 'Driver will pick you up along their route.';
      if (plannedReserveFromText) plannedReserveFromText.innerHTML = `📍 <strong>From:</strong> <span>${fullPickup}</span>`;
      if (plannedReserveToText) plannedReserveToText.innerHTML = `🎯 <strong>To:</strong> <span>${dest}</span>`;
      if (plannedReserveNoteLabel) plannedReserveNoteLabel.textContent = 'Note for Driver (Optional)';
      if (plannedReserveNoteInput) plannedReserveNoteInput.placeholder = 'e.g. Near blue gate, 1 bag';
      if (plannedReservePickupInput && !plannedReservePickupInput.value) plannedReservePickupInput.placeholder = 'Enter pickup address…';

      if (plan.isReturnRide && plannedReserveReturnWrap) {
        plannedReserveReturnWrap.classList.remove('is-hidden');
      } else if (plannedReserveReturnWrap) {
        plannedReserveReturnWrap.classList.add('is-hidden');
      }

      const isReturn = !!(plan.isReturnRide && plannedReserveReturnCheckbox && plannedReserveReturnCheckbox.checked);
      if (plannedReserveFareDisplay) plannedReserveFareDisplay.textContent = `R ${Math.round(isReturn ? returnFare : oneWayFare)}`;
      if (plannedReserveSubmitBtn) plannedReserveSubmitBtn.innerHTML = '<span>⚡</span> Confirm Seat Reservation';
    } else if (kind === 'DELIVER') {
      if (plannedReserveTitle) plannedReserveTitle.textContent = 'Send a Delivery';
      if (plannedReserveSubtitle) plannedReserveSubtitle.textContent = 'Driver delivers your parcel along this route';
      if (plannedReserveBadge) plannedReserveBadge.textContent = 'ERRAND DELIVERY';
      if (plannedReserveFareLabel) plannedReserveFareLabel.textContent = 'Delivery Fare:';
      if (plannedReserveLocationLabel) plannedReserveLocationLabel.innerHTML = 'Parcel Collection Location';
      if (plannedReserveLocationHint) plannedReserveLocationHint.textContent = 'Driver will collect the package from you at this location.';
      if (plannedReserveFromText) plannedReserveFromText.innerHTML = `📍 <strong>Collection:</strong> <span>Your address</span>`;
      if (plannedReserveToText) plannedReserveToText.innerHTML = `🎯 <strong>Deliver to:</strong> <span>${dest}</span>`;
      if (plannedReserveNoteLabel) plannedReserveNoteLabel.innerHTML = 'Parcel Description & Recipient Contact <span class="field-req">required</span>';
      if (plannedReserveNoteInput) plannedReserveNoteInput.placeholder = 'e.g. 1 small parcel, Deliver to John 0821234567';
      if (plannedReservePickupInput && !plannedReservePickupInput.value) plannedReservePickupInput.placeholder = 'Enter parcel collection address…';

      if (plannedReserveReturnWrap) plannedReserveReturnWrap.classList.add('is-hidden');
      if (plannedReserveFareDisplay) plannedReserveFareDisplay.textContent = `R ${Math.round(oneWayFare)}`;
      if (plannedReserveSubmitBtn) plannedReserveSubmitBtn.innerHTML = '<span>📦</span> Confirm Errand Delivery';
    } else if (kind === 'FETCH') {
      if (plannedReserveTitle) plannedReserveTitle.textContent = 'Fetch an Item';
      if (plannedReserveSubtitle) plannedReserveSubtitle.textContent = 'Driver fetches an item at destination and returns it to you';
      if (plannedReserveBadge) plannedReserveBadge.textContent = 'ERRAND FETCH';
      if (plannedReserveFareLabel) plannedReserveFareLabel.textContent = 'Fetch Fare:';
      if (plannedReserveLocationLabel) plannedReserveLocationLabel.innerHTML = 'Your Drop-off Location';
      if (plannedReserveLocationHint) plannedReserveLocationHint.textContent = 'Driver will bring the fetched item to you at this location.';
      if (plannedReserveFromText) plannedReserveFromText.innerHTML = `📍 <strong>Fetch at:</strong> <span>${dest}</span>`;
      if (plannedReserveToText) plannedReserveToText.innerHTML = `🎯 <strong>Drop-off:</strong> <span>Your address</span>`;
      if (plannedReserveNoteLabel) plannedReserveNoteLabel.innerHTML = 'Item Details & Collection Contact <span class="field-req">required</span>';
      if (plannedReserveNoteInput) plannedReserveNoteInput.placeholder = 'e.g. Order #445 at reception, collect from Sarah';
      if (plannedReservePickupInput && !plannedReservePickupInput.value) plannedReservePickupInput.placeholder = 'Enter drop-off address…';

      if (plannedReserveReturnWrap) plannedReserveReturnWrap.classList.add('is-hidden');
      const fetchFare = Math.round(plan.returnFare || oneWayFare);
      if (plannedReserveFareDisplay) plannedReserveFareDisplay.textContent = `R ${fetchFare}`;
      if (plannedReserveSubmitBtn) plannedReserveSubmitBtn.innerHTML = '<span>🛍️</span> Confirm Errand Fetch';
    }
  }

  function openPlannedReserveModal(plan, initialKind = 'PASSENGER') {
    if (!plan) return;
    selectedPlannedRide = plan;
    const dest = (plan.destination && plan.destination.address) || plan.destination || '';
    const cleanDest = typeof dest === 'string' ? dest.split(',')[0].trim() : 'Destination';
    if (plannedReserveDestHeader) plannedReserveDestHeader.textContent = `Going to "${cleanDest}"`;

    const epoch = readEpochMillis(plan.startAt || plan.departure);
    const timeStr = formatDepartureDateTime(epoch);
    const seats = plan.availablePlaces ?? plan.seats ?? 0;
    if (plannedReserveTimeSeats) plannedReserveTimeSeats.textContent = `Departs ${timeStr} · ${seats} seats available`;

    if (plannedRoleToggleGroup) {
      if (plannedRolePassenger) plannedRolePassenger.style.display = seats > 0 ? '' : 'none';
      if (plannedRoleDeliver) plannedRoleDeliver.style.display = plan.allowErrands ? '' : 'none';
      if (plannedRoleFetch) plannedRoleFetch.style.display = (plan.allowErrands && plan.isReturnRide) ? '' : 'none';
    }

    const defaultKind = (seats <= 0 && plan.allowErrands) ? 'DELIVER' : initialKind;
    selectPlannedRole(defaultKind);

    // Leave pickup input empty so user enters their own location (not pre-populated with driver's route point)
    reservePickupLocation = null;
    if (plannedReservePickupInput) {
      plannedReservePickupInput.value = '';
      plannedReservePickupInput.placeholder = defaultKind === 'FETCH' ? 'Enter drop-off address…' : (defaultKind === 'DELIVER' ? 'Enter parcel collection address…' : 'Enter pickup address…');
    }

    // Attach Google Places Autocomplete if not already attached
    ensurePlannedReserveAutocomplete();

    if (plannedReserveNoteInput) plannedReserveNoteInput.value = '';
    if (plannedReserveError) {
      plannedReserveError.textContent = '';
      plannedReserveError.classList.add('is-hidden');
    }

    if (plannedReserveSubmitBtn) {
      plannedReserveSubmitBtn.disabled = false;
    }

    if (plannedReserveModal) plannedReserveModal.classList.remove('is-hidden');
  }

  function closePlannedReserveModal() {
    if (plannedReserveModal) plannedReserveModal.classList.add('is-hidden');
    selectedPlannedRide = null;
  }

  async function handlePlannedReserveSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!selectedPlannedRide) return;

    if (!currentUser) {
      if (plannedReserveError) {
        plannedReserveError.textContent = 'Please sign in to reserve a seat.';
        plannedReserveError.classList.remove('is-hidden');
      }
      return;
    }

    const pickupAddr = plannedReservePickupInput ? plannedReservePickupInput.value.trim() : '';
    if (!pickupAddr) {
      if (plannedReserveError) {
        plannedReserveError.textContent = 'Please enter your location.';
        plannedReserveError.classList.remove('is-hidden');
      }
      return;
    }

    const note = plannedReserveNoteInput ? plannedReserveNoteInput.value.trim() : '';
    if ((selectedPlannedKind === 'DELIVER' || selectedPlannedKind === 'FETCH') && !note) {
      if (plannedReserveError) {
        plannedReserveError.textContent = 'Please describe the package/item and recipient contact in the note.';
        plannedReserveError.classList.remove('is-hidden');
      }
      return;
    }

    const loc = {
      address: pickupAddr,
      lat: (reservePickupLocation && typeof reservePickupLocation.lat === 'number') ? reservePickupLocation.lat : ((selectedPlannedRide.pickup && selectedPlannedRide.pickup.lat) || POORTJIE_MAP_CENTER.lat),
      lng: (reservePickupLocation && typeof reservePickupLocation.lng === 'number') ? reservePickupLocation.lng : ((selectedPlannedRide.pickup && selectedPlannedRide.pickup.lng) || POORTJIE_MAP_CENTER.lng)
    };

    if (plannedReserveSubmitBtn) {
      plannedReserveSubmitBtn.disabled = true;
      plannedReserveSubmitBtn.innerHTML = '<span>⏳</span> Submitting…';
    }
    if (plannedReserveError) plannedReserveError.classList.add('is-hidden');

    try {
      const token = await currentUser.getIdToken();
      const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));
      const isReturn = !!(selectedPlannedKind === 'PASSENGER' && selectedPlannedRide.isReturnRide && plannedReserveReturnCheckbox && plannedReserveReturnCheckbox.checked);

      const payload = {
        requestId: requestId,
        kind: selectedPlannedKind,
        isReturnRide: isReturn,
        note: note,
        location: loc
      };

      const resp = await fetch(`https://api.digilayn.co.za/planned-rides/${selectedPlannedRide.id}/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Layn-App': 'laynrider',
          'X-Layn-Environment': fleetEnvironment
        },
        body: JSON.stringify(payload)
      });

      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || 'Failed to submit request. Please try again.';
        if (plannedReserveError) {
          plannedReserveError.textContent = msg;
          plannedReserveError.classList.remove('is-hidden');
        }
        if (plannedReserveSubmitBtn) {
          plannedReserveSubmitBtn.disabled = false;
        }
        return;
      }

      closePlannedReserveModal();
      if (plannedModal && !plannedModal.classList.contains('is-hidden')) {
        plannedModal.classList.add('is-hidden');
      }
      const successMsg = selectedPlannedKind === 'DELIVER'
        ? '📦 Delivery errand requested! Driver will contact you.'
        : (selectedPlannedKind === 'FETCH' ? '🛍️ Fetch errand requested! Driver will contact you.' : '🎉 Seat reserved! Pay driver directly upon boarding.');
      showToast(successMsg);
    } catch (err) {
      console.error('[LaynRider] Seat reservation error:', err);
      if (plannedReserveError) {
        plannedReserveError.textContent = err.message || 'Network error. Please try again.';
        plannedReserveError.classList.remove('is-hidden');
      }
      if (plannedReserveSubmitBtn) {
        plannedReserveSubmitBtn.disabled = false;
      }
    }
  }

  function openPlannedBookingDetailsModal(booking) {
    if (!booking) return;
    selectedPlannedBooking = booking;

    const epoch = readEpochMillis(booking.departure || booking.startAt);
    const timeStr = epoch ? new Date(epoch).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
    if (plannedBookingTime) plannedBookingTime.textContent = `Departs ${timeStr}`;

    const dest = (booking.destination && booking.destination.address) || booking.destination || '—';
    const pickup = (booking.pickup && booking.pickup.address) || booking.pickup || '—';
    if (plannedBookingPickup) plannedBookingPickup.textContent = pickup;
    if (plannedBookingDropoff) plannedBookingDropoff.textContent = dest;

    const fare = booking.fare || booking.oneWayFare;
    if (plannedBookingFare) plannedBookingFare.textContent = typeof fare === 'number' ? `R ${Math.round(fare)}` : 'R --';

    const status = booking.status === 'ACCEPTED' ? 'CONFIRMED' : (booking.status || 'BOOKED');
    if (plannedBookingStatusPill) plannedBookingStatusPill.textContent = status;

    if (plannedBookingDriverBox) {
      if (booking.driverName) {
        plannedBookingDriverBox.classList.remove('is-hidden');
        if (plannedBookingDriverName) plannedBookingDriverName.textContent = booking.driverName;
        if (plannedBookingVehicle) plannedBookingVehicle.textContent = booking.vehicleType || 'Fleet Vehicle';
        if (plannedBookingDriverPhoto) {
          plannedBookingDriverPhoto.src = booking.driverPhotoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(booking.driverName)}&background=22c55e&color=fff&size=88`;
        }
      } else {
        plannedBookingDriverBox.classList.add('is-hidden');
      }
    }

    if (plannedBookingError) {
      plannedBookingError.textContent = '';
      plannedBookingError.classList.add('is-hidden');
    }
    if (plannedBookingWithdrawBtn) {
      plannedBookingWithdrawBtn.disabled = false;
      plannedBookingWithdrawBtn.textContent = 'Withdraw Reservation';
    }

    if (plannedBookingDetailsModal) plannedBookingDetailsModal.classList.remove('is-hidden');
  }

  function closePlannedBookingDetailsModal() {
    if (plannedBookingDetailsModal) plannedBookingDetailsModal.classList.add('is-hidden');
    selectedPlannedBooking = null;
  }

  async function handlePlannedWithdraw() {
    if (!selectedPlannedBooking) return;
    if (!confirm('Are you sure you want to withdraw your reserved seat?')) {
      return;
    }
    if (!auth.currentUser) return;

    const planId = selectedPlannedBooking.planId || selectedPlannedBooking.id;
    const requestId = selectedPlannedBooking.requestId || selectedPlannedBooking.id;

    if (plannedBookingWithdrawBtn) {
      plannedBookingWithdrawBtn.disabled = true;
      plannedBookingWithdrawBtn.textContent = 'Withdrawing…';
    }
    if (plannedBookingError) plannedBookingError.classList.add('is-hidden');

    try {
      const token = await auth.currentUser.getIdToken();
      const actionId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('act_' + Date.now());

      const resp = await fetch(`https://api.digilayn.co.za/planned-rides/${planId}/requests/${requestId}/withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Layn-App': 'laynrider',
          'X-Layn-Environment': fleetEnvironment
        },
        body: JSON.stringify({
          actionId: actionId,
          reason: 'Rider withdrew seat reservation'
        })
      });

      const data = await resp.json().catch(() => null);

      if (!resp.ok) {
        const msg = (data && data.error && data.error.message) || 'Failed to withdraw reservation.';
        if (plannedBookingError) {
          plannedBookingError.textContent = msg;
          plannedBookingError.classList.remove('is-hidden');
        }
        if (plannedBookingWithdrawBtn) {
          plannedBookingWithdrawBtn.disabled = false;
          plannedBookingWithdrawBtn.textContent = 'Withdraw Reservation';
        }
        return;
      }

      closePlannedBookingDetailsModal();
      showToast('Reservation withdrawn.');
    } catch (err) {
      console.error('[LaynRider] Withdraw error:', err);
      if (plannedBookingError) {
        plannedBookingError.textContent = err.message || 'Network error.';
        plannedBookingError.classList.remove('is-hidden');
      }
      if (plannedBookingWithdrawBtn) {
        plannedBookingWithdrawBtn.disabled = false;
        plannedBookingWithdrawBtn.textContent = 'Withdraw Reservation';
      }
    }
  }

  /** Switch primary UI views */
  function showView(viewName) {
    if (bootView) bootView.classList.add('is-hidden');
    if (authGateView) authGateView.classList.add('is-hidden');
    if (suspendedView) suspendedView.classList.add('is-hidden');
    if (termsGateView) termsGateView.classList.add('is-hidden');
    if (profileGateView) profileGateView.classList.add('is-hidden');
    if (appView) appView.classList.add('is-hidden');

    if (viewName === 'boot') {
      if (bootView) bootView.classList.remove('is-hidden');
    } else if (viewName === 'auth') {
      if (authGateView) authGateView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.remove('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.add('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.add('is-hidden');
    } else if (viewName === 'suspended') {
      if (suspendedView) suspendedView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.add('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.remove('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.remove('is-hidden');
    } else if (viewName === 'terms') {
      if (termsGateView) termsGateView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.add('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.remove('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.remove('is-hidden');
    } else if (viewName === 'profile-gate') {
      if (profileGateView) profileGateView.classList.remove('is-hidden');
      if (headerSignInBtn) headerSignInBtn.classList.add('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.remove('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.remove('is-hidden');
    } else if (viewName === 'app') {
      if (appView) appView.classList.remove('is-hidden');
      if (currentUser) {
        if (headerSignInBtn) headerSignInBtn.classList.add('is-hidden');
        if (headerUserBtn) headerUserBtn.classList.remove('is-hidden');
        if (headerSignOutBtn) headerSignOutBtn.classList.remove('is-hidden');
      } else {
        if (headerSignInBtn) headerSignInBtn.classList.remove('is-hidden');
        if (headerUserBtn) headerUserBtn.classList.add('is-hidden');
        if (headerSignOutBtn) headerSignOutBtn.classList.add('is-hidden');
      }
    }
  }

  /** Helper to format transport type labels */
  function formatVehicleType(type) {
    switch (type) {
      case 'PRIVATE_CAR': return 'Private Car';
      case 'MINI_BUS': return 'Mini Bus';
      case 'BAKKIE': return 'Bakkie';
      case 'MOTORBIKE': return 'Motorbike';
      case 'TUK_TUK': return 'TukTuk';
      default: return type ? type.replace(/_/g, ' ') : 'Private Car';
    }
  }

  /** Fetch user identity for driver */
  async function getDriverIdentity(uid) {
    if (!uid) return {};
    if (userCache.has(uid)) {
      return userCache.get(uid);
    }
    try {
      const doc = await usersCol.doc(uid).get();
      const data = doc.exists ? doc.data() : {};
      userCache.set(uid, data);
      return data;
    } catch (e) {
      console.warn('Failed to load driver identity for:', uid, e);
      return {};
    }
  }

  /** Fetch driver vehicle & record */
  async function getDriverRecord(uid) {
    if (!uid) return {};
    try {
      const doc = await driversCol.doc(uid).get();
      return doc.exists ? doc.data() : {};
    } catch (e) {
      console.warn('Failed to load driver doc for:', uid, e);
      return {};
    }
  }

  /**
   * Fetch a driver's real ratings/reviews from Firestore. Mirrors Android
   * FirestoreRatingRepository.observeDriverReviews (targetUid + RIDER_TO_DRIVER).
   * STRICT: no synthetic/sample fallback data — returns [] when there are none.
   */
  async function getDriverReviews(driverUid) {
    if (!driverUid) return [];
    if (driverReviewsCache.has(driverUid)) {
      return driverReviewsCache.get(driverUid);
    }
    try {
      const snap = await ratingsCol
        .where('targetUid', '==', driverUid)
        .where('direction', '==', 'RIDER_TO_DRIVER')
        .limit(20)
        .get();

      let likedSet = new Set();
      if (currentUser) {
        try {
          const likesSnap = await reviewLikesCol
            .where('byUid', '==', currentUser.uid)
            .get();
          likedSet = new Set(likesSnap.docs.filter(d => d.data().liked === true).map(d => d.data().ratingId));
        } catch (err) {
          console.warn('Error fetching review likes:', err);
        }
      }

      const list = snap.docs
        .map(d => {
          const data = d.data();
          return {
            id: d.id,
            ...data,
            likes: Math.max(0, data.likes || 0),
            likedByCurrentUser: likedSet.has(d.id),
          };
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      driverReviewsCache.set(driverUid, list);
      return list;
    } catch (e) {
      console.warn('Error fetching driver reviews:', e);
      return [];
    }
  }

  /**
   * Toggle social like on a driver review (mirrors Android FirestoreRatingRepository.likeReview).
   * Atomically flips like doc and increments/decrements rating likes counter.
   */
  async function toggleLikeReview(ratingId, driverUid) {
    if (!currentUser) {
      showToast('Sign in to like reviews.');
      return;
    }
    try {
      await riderApi.request('POST', `/ratings/${ratingId}/like`, {});
      driverReviewsCache.delete(driverUid);
      if (activeDriverModal && activeDriverModal.uid === driverUid) {
        openDriverModal(activeDriverModal);
      }
    } catch (err) {
      console.warn('Error toggling like:', err);
      showToast('Could not update like.');
    }
  }

  /** Mask reviewer/user names with asterisks (e.g. "John Doe" -> "J*** D***") for privacy. */
  function maskUserName(name) {
    if (!name || !name.trim()) return '***';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '***';
    return parts.map(part => `${part.charAt(0)}***`).join(' ');
  }

  /** Normalise a rating doc's reviewer name (Android writes reviewerName; older docs used byName). */
  function reviewerNameOf(r) {
    return (r && (r.reviewerName || r.byName)) || 'Rider';
  }

  /** ============================================================
   * GOOGLE MAPS & DIRECTIONS INTEGRATION
   * ============================================================ */
  function initBookingMap() {
    if (bookingGoogleMap || !bookingMapEl || !global.google || !global.google.maps) return;

    try {
      console.log('[LaynRider Map] 🗺️ Initializing Booking Google Map...');
      const poortjieCenter = new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
      const defaultMapCenter = new google.maps.LatLng(POORTJIE_MAP_CENTER.lat, POORTJIE_MAP_CENTER.lng);
      bookingGoogleMap = new google.maps.Map(bookingMapEl, {
        center: defaultMapCenter,
        zoom: 16,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false
      });

      bookingPoortjieCircle = new google.maps.Circle({
        center: poortjieCenter,
        radius: SERVICE_AREA.radiusMeters,
        strokeColor: window.DigilaynTheme.getColor('info'),
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: window.DigilaynTheme.getColor('info'),
        fillOpacity: 0.12,
        map: bookingGoogleMap
      });

      bookingDirectionsService = new google.maps.DirectionsService();
      bookingDirectionsRenderer = new google.maps.DirectionsRenderer({
        map: bookingGoogleMap,
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: window.DigilaynTheme.getColor('info'),
          strokeWeight: 5,
          strokeOpacity: 0.9
        }
      });
      console.log('[LaynRider Map] ✅ Booking Google Map initialized successfully.');
    } catch (err) {
      console.error('[LaynRider Map] ❌ Error initializing booking map:', err);
    }
  }

  function updateBookingMap() {
    if (!bookingGoogleMap) {
      initBookingMap();
    }
    if (!bookingGoogleMap) return;

    const hasPickupAddress = Boolean(bookingState.pickup && bookingState.pickup.address && bookingState.pickup.address.trim());
    const hasPickupCoords = Boolean(bookingState.pickup && typeof bookingState.pickup.lat === 'number' && typeof bookingState.pickup.lng === 'number' && !isNaN(bookingState.pickup.lat) && bookingState.pickup.lat !== 0);
    const hasDropoffAddress = Boolean(bookingState.dropoff && bookingState.dropoff.address && bookingState.dropoff.address.trim());
    const hasDropoffCoords = Boolean(bookingState.dropoff && typeof bookingState.dropoff.lat === 'number' && typeof bookingState.dropoff.lng === 'number' && !isNaN(bookingState.dropoff.lat) && bookingState.dropoff.lat !== 0);

    const hasPickup = hasPickupAddress && hasPickupCoords;
    const hasDropoff = hasDropoffAddress && hasDropoffCoords;

    console.log('[LaynRider Map] 🗺️ [BOOKING MAP UPDATE] hasPickup=' + hasPickup + ', hasDropoff=' + hasDropoff);

    // Update Pickup Marker
    if (hasPickup) {
      const pos = new google.maps.LatLng(bookingState.pickup.lat, bookingState.pickup.lng);
      if (!bookingPickupMarker) {
        bookingPickupMarker = new google.maps.Marker({
          position: pos,
          map: bookingGoogleMap,
          title: 'Pickup: ' + (bookingState.pickup.address || 'Pickup'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        bookingPickupMarker.setPosition(pos);
        bookingPickupMarker.setMap(bookingGoogleMap);
      }
    } else if (bookingPickupMarker) {
      bookingPickupMarker.setMap(null);
      bookingPickupMarker = null;
    }

    // Update Dropoff Marker
    if (hasDropoff) {
      const pos = new google.maps.LatLng(bookingState.dropoff.lat, bookingState.dropoff.lng);
      if (!bookingDropoffMarker) {
        bookingDropoffMarker = new google.maps.Marker({
          position: pos,
          map: bookingGoogleMap,
          title: 'Drop-off: ' + (bookingState.dropoff.address || 'Destination'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        bookingDropoffMarker.setPosition(pos);
        bookingDropoffMarker.setMap(bookingGoogleMap);
      }
    } else if (bookingDropoffMarker) {
      bookingDropoffMarker.setMap(null);
      bookingDropoffMarker = null;
    }

    // Calculate Driving Route Directions if both endpoints are set with valid addresses & coordinates
    if (hasPickup && hasDropoff) {
      const origin = new google.maps.LatLng(bookingState.pickup.lat, bookingState.pickup.lng);
      const destination = new google.maps.LatLng(bookingState.dropoff.lat, bookingState.dropoff.lng);

      console.log('[LaynRider Map] 🗺️ [DIRECTIONS START] Origin: (' + bookingState.pickup.lat + ', ' + bookingState.pickup.lng + ') -> Dest: (' + bookingState.dropoff.lat + ', ' + bookingState.dropoff.lng + ')');

      // Clear existing distance/price while calculating so the UI displays calculating state
      bookingState.actualOneWayDistanceKm = null;
      updateUpfrontFarePreview(null);

      const request = {
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING
      };

      bookingDirectionsService.route(request, (result, status) => {
        const response = result || {};
        console.log("=== GOOGLE MAPS ROUTE QA LOG ===");
        console.log("API Status Code:", response.status || status);
        if (response.routes && response.routes[0]) {
            const leg = response.routes[0].legs[0];
            console.log("Verification Status: SUCCESS (Using actual road grid)");
            console.log("Total Turn-by-Turn Steps:", leg.steps.length);
            console.log("API Calculated Real Distance:", leg.distance.text, `(${leg.distance.value} meters)`);
        } else {
            console.log("Verification Status: FAILED (Check for coordinate inversion or off-road pins)");
        }
        console.log("================================");

        if (status === google.maps.DirectionsStatus.OK) {
          bookingDirectionsRenderer.setDirections(result);
          const route = result.routes[0];
          const leg = route.legs[0];
          console.log('[LaynRider Map] ✅ [DIRECTIONS SUCCESS] Route: ' + leg.distance.text + ', duration: ' + leg.duration.text + ', path points: ' + route.overview_path.length);

          if (bookingMapRouteInfo) {
            if (bookingMapDistance) bookingMapDistance.textContent = leg.distance.text;
            if (bookingMapDuration) bookingMapDuration.textContent = leg.duration.text;
            bookingMapRouteInfo.classList.remove('is-hidden');
          }

          if (leg.distance && typeof leg.distance.value === 'number') {
            const distKm = leg.distance.value / 1000.0;
            bookingState.actualOneWayDistanceKm = distKm;
            updateUpfrontFarePreview(distKm);
          }

          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          bookingGoogleMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
        } else {
          console.warn('[LaynRider Map] ⚠️ [DIRECTIONS WARN] Directions request failed with status: ' + status);
          bookingState.actualOneWayDistanceKm = null;
          if (bookingMapRouteInfo) bookingMapRouteInfo.classList.add('is-hidden');
          updateBookingDistancePreview(null);
          const distanceBreakdownEl = document.getElementById('booking-distance-breakdown') || document.getElementById('booking-fare-breakdown');
          if (distanceBreakdownEl) distanceBreakdownEl.textContent = 'Could not determine driving route. Check addresses.';
          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          bookingGoogleMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
        }
      });
    } else {
      bookingState.actualOneWayDistanceKm = null;
      if (bookingDirectionsRenderer) {
        bookingDirectionsRenderer.set('directions', null);
      }
      if (bookingMapRouteInfo) bookingMapRouteInfo.classList.add('is-hidden');
      updateBookingDistancePreview(null);

      if (hasPickup) {
        bookingGoogleMap.setCenter(new google.maps.LatLng(bookingState.pickup.lat, bookingState.pickup.lng));
        bookingGoogleMap.setZoom(15);
      } else if (hasDropoff) {
        bookingGoogleMap.setCenter(new google.maps.LatLng(bookingState.dropoff.lat, bookingState.dropoff.lng));
        bookingGoogleMap.setZoom(14);
      } else {
        bookingGoogleMap.setCenter(new google.maps.LatLng(POORTJIE_MAP_CENTER.lat, POORTJIE_MAP_CENTER.lng));
        bookingGoogleMap.setZoom(16);
      }
    }
  }

  function initTrackingMap() {
    if (trackingGoogleMap || !trackingMapEl || !global.google || !global.google.maps) return;

    try {
      console.log('[LaynRider Map] 🗺️ Initializing Tracking Google Map...');
      const defaultMapCenter = new google.maps.LatLng(POORTJIE_MAP_CENTER.lat, POORTJIE_MAP_CENTER.lng);
      trackingGoogleMap = new google.maps.Map(trackingMapEl, {
        center: defaultMapCenter,
        zoom: 16,
        disableDefaultUI: true,
        zoomControl: true,
        clickableIcons: false
      });

      trackingDirectionsService = new google.maps.DirectionsService();
      trackingDirectionsRenderer = new google.maps.DirectionsRenderer({
        map: trackingGoogleMap,
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: window.DigilaynTheme.getColor('info'),
          strokeWeight: 5,
          strokeOpacity: 0.9
        }
      });
      console.log('[LaynRider Map] ✅ Tracking Google Map initialized successfully.');
    } catch (err) {
      console.error('[LaynRider Map] ❌ Error initializing tracking map:', err);
    }
  }

  function updateTrackingMap(b) {
    if (!b) return;
    if (!trackingGoogleMap) {
      initTrackingMap();
    }
    if (!trackingGoogleMap) return;

    const p = b.pickup || {};
    const d = b.dropoff || {};
    const hasP = typeof p.lat === 'number' && typeof p.lng === 'number' && p.lat !== 0;
    const hasD = typeof d.lat === 'number' && typeof d.lng === 'number' && d.lat !== 0;

    if (hasP) {
      const pPos = new google.maps.LatLng(p.lat, p.lng);
      if (!trackingPickupMarker) {
        trackingPickupMarker = new google.maps.Marker({
          position: pPos,
          map: trackingGoogleMap,
          title: 'Pickup: ' + (p.address || 'Pickup'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        trackingPickupMarker.setPosition(pPos);
        trackingPickupMarker.setMap(trackingGoogleMap);
      }
    }

    if (hasD) {
      const dPos = new google.maps.LatLng(d.lat, d.lng);
      if (!trackingDropoffMarker) {
        trackingDropoffMarker = new google.maps.Marker({
          position: dPos,
          map: trackingGoogleMap,
          title: 'Drop-off: ' + (d.address || 'Destination'),
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        trackingDropoffMarker.setPosition(dPos);
        trackingDropoffMarker.setMap(trackingGoogleMap);
      }
    }

    // Check for Driver Location
    const driverUid = b.driverId || b.requestedDriverId;
    const rawPresence = driverUid ? rtdbPresence[driverUid] : null;
    const driverPresence = rawPresence && Object.prototype.hasOwnProperty.call(rawPresence, 'activeSessionId')
      ? rawPresence.sessions?.[rawPresence.activeSessionId]
      : rawPresence;
    const hasDriverLoc = driverPresence && typeof driverPresence.lat === 'number' && typeof driverPresence.lng === 'number' && driverPresence.lat !== 0;

    if (hasDriverLoc) {
      const driverPos = new google.maps.LatLng(driverPresence.lat, driverPresence.lng);
      if (!trackingDriverMarker) {
        trackingDriverMarker = new google.maps.Marker({
          position: driverPos,
          map: trackingGoogleMap,
          title: 'Driver Location',
          icon: {
            url: 'https://maps.google.com/mapfiles/ms/icons/yellow-dot.png',
            scaledSize: new google.maps.Size(32, 32)
          }
        });
      } else {
        trackingDriverMarker.setPosition(driverPos);
        trackingDriverMarker.setMap(trackingGoogleMap);
      }
    } else if (trackingDriverMarker) {
      trackingDriverMarker.setMap(null);
    }

    if (hasP && hasD) {
      const origin = new google.maps.LatLng(p.lat, p.lng);
      const destination = new google.maps.LatLng(d.lat, d.lng);

      console.log('[LaynRider Map] 🗺️ [TRACKING DIRECTIONS START] Origin: (' + p.lat + ', ' + p.lng + ') -> Dest: (' + d.lat + ', ' + d.lng + ')');

      const request = {
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING
      };

      trackingDirectionsService.route(request, (result, status) => {
        const response = result || {};
        console.log("=== GOOGLE MAPS ROUTE QA LOG ===");
        console.log("API Status Code:", response.status || status);
        if (response.routes && response.routes[0]) {
            const leg = response.routes[0].legs[0];
            console.log("Verification Status: SUCCESS (Using actual road grid)");
            console.log("Total Turn-by-Turn Steps:", leg.steps.length);
            console.log("API Calculated Real Distance:", leg.distance.text, `(${leg.distance.value} meters)`);
        } else {
            console.log("Verification Status: FAILED (Check for coordinate inversion or off-road pins)");
        }
        console.log("================================");

        if (status === google.maps.DirectionsStatus.OK) {
          trackingDirectionsRenderer.setDirections(result);
          const route = result.routes[0];
          const leg = route.legs[0];
          console.log('[LaynRider Map] ✅ [TRACKING DIRECTIONS SUCCESS] ' + leg.distance.text + ', ' + leg.duration.text);

          if (trackingMapRouteInfo) {
            if (trackingMapDistance) trackingMapDistance.textContent = leg.distance.text;
            if (trackingMapDuration) trackingMapDuration.textContent = leg.duration.text;
            trackingMapRouteInfo.classList.remove('is-hidden');
          }

          const bounds = new google.maps.LatLngBounds();
          bounds.extend(origin);
          bounds.extend(destination);
          if (hasDriverLoc) bounds.extend(new google.maps.LatLng(driverPresence.lat, driverPresence.lng));
          trackingGoogleMap.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
        } else {
          console.warn('[LaynRider Map] ⚠️ [TRACKING DIRECTIONS WARN] Status: ' + status);
        }
      });
    }
  }

  global.initGooglePlaces = function () {
    if (!global.google || !global.google.maps || !global.google.maps.places) {
      console.warn('Google Places library not yet ready.');
      return;
    }

    initBookingMap();

    const poortjieCenter = new google.maps.LatLng(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng);
    const circle = new google.maps.Circle({ center: poortjieCenter, radius: SERVICE_AREA.radiusMeters });

    if (pickupAddressInput) {
      const pickupAutocomplete = new google.maps.places.Autocomplete(pickupAddressInput, {
        bounds: circle.getBounds(),
        componentRestrictions: { country: 'za' },
        fields: ['formatted_address', 'name', 'geometry']
      });

      pickupAutocomplete.addListener('place_changed', () => {
        const place = pickupAutocomplete.getPlace();
        if (place && place.geometry && place.geometry.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const addr = place.formatted_address || place.name || pickupAddressInput.value;
          setPickupLocation(addr, lat, lng);
          updateBookingMap();
        }
      });
    }

    if (dropoffAddressInput) {
      const dropoffAutocomplete = new google.maps.places.Autocomplete(dropoffAddressInput, {
        componentRestrictions: { country: 'za' },
        fields: ['formatted_address', 'name', 'geometry']
      });

      dropoffAutocomplete.addListener('place_changed', () => {
        const place = dropoffAutocomplete.getPlace();
        if (place && place.geometry && place.geometry.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const addr = place.formatted_address || place.name || dropoffAddressInput.value;
          setDropoffLocation(addr, lat, lng);
        }
      });
    }

    if (schedulePickupInput) {
      const schedulePickupAutocomplete = new google.maps.places.Autocomplete(schedulePickupInput, {
        bounds: circle.getBounds(),
        componentRestrictions: { country: 'za' },
        fields: ['formatted_address', 'name', 'geometry']
      });

      schedulePickupAutocomplete.addListener('place_changed', () => {
        const place = schedulePickupAutocomplete.getPlace();
        if (place && place.geometry && place.geometry.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const addr = place.formatted_address || place.name || schedulePickupInput.value;
          scheduleState.pickup = { address: addr, lat, lng };
          updateScheduleFareEstimate();
        }
      });
    }

    if (scheduleDropoffInput) {
      const scheduleDropoffAutocomplete = new google.maps.places.Autocomplete(scheduleDropoffInput, {
        componentRestrictions: { country: 'za' },
        fields: ['formatted_address', 'name', 'geometry']
      });

      scheduleDropoffAutocomplete.addListener('place_changed', () => {
        const place = scheduleDropoffAutocomplete.getPlace();
        if (place && place.geometry && place.geometry.location) {
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const addr = place.formatted_address || place.name || scheduleDropoffInput.value;
          scheduleState.dropoff = { address: addr, lat, lng };
          updateScheduleFareEstimate();
        }
      });
    }

    ensurePlannedReserveAutocomplete();
  };

  /** ============================================================
   * MODULAR MULTI-STEP BOOKING FORM IMPLEMENTATION
   * ============================================================ */

  let currentBookingStep = 1;

  function setBookingStep(step) {
    currentBookingStep = step;

    // 1. Update Header Title & Subtitle & Back Button
    if (bookingModalBack) {
      bookingModalBack.classList.toggle('is-hidden', step === 1);
    }

    if (bookingStepTitle && bookingStepSubtitle) {
      if (step === 1) {
        bookingStepTitle.textContent = 'Where are you?';
        bookingStepSubtitle.textContent = 'Enter pickup address or use GPS';
      } else if (step === 2) {
        bookingStepTitle.textContent = 'Where are you going?';
        bookingStepSubtitle.textContent = 'Search any destination address';
      } else if (step === 3) {
        bookingStepTitle.textContent = 'Review Your Ride';
        bookingStepSubtitle.textContent = 'Confirm ride details and fare';
      }
    }

    // 2. Update Stepper Progress Dots
    const stepIndicators = [bookingStepIndicator1, bookingStepIndicator2, bookingStepIndicator3];
    stepIndicators.forEach((el, idx) => {
      if (!el) return;
      const s = idx + 1;
      el.classList.toggle('is-active', s === step);
      el.classList.toggle('is-completed', s < step);
    });

    // 3. Update Panes Visibility
    if (bookingStepPickup) bookingStepPickup.classList.toggle('is-hidden', step !== 1);
    if (bookingStepDropoff) bookingStepDropoff.classList.toggle('is-hidden', step !== 2);
    if (bookingStepOptions) bookingStepOptions.classList.toggle('is-hidden', step !== 3);

    // 4. Move Map to the active step's map slot
    if (bookingMapCard) {
      if (step === 1 && bookingMapContainerStep1) {
        bookingMapContainerStep1.appendChild(bookingMapCard);
      } else if (step === 2 && bookingMapContainerStep2) {
        bookingMapContainerStep2.appendChild(bookingMapCard);
      } else if (step === 3 && bookingMapContainerStep3) {
        bookingMapContainerStep3.appendChild(bookingMapCard);
      }
    }

    // 5. Update Step-specific data
    if (step === 2) {
      if (step2PickupSummaryText) {
        step2PickupSummaryText.textContent = (bookingState.pickup && bookingState.pickup.address) || 'Current Location';
      }
      const hasDropoff = Boolean(bookingState.dropoff && bookingState.dropoff.address && bookingState.dropoff.address.trim());
      if (step2TripTypeSection) {
        step2TripTypeSection.classList.toggle('is-hidden', !hasDropoff);
      }
      updateTripTypeButtons();
    } else if (step === 3) {
      updateReviewSummary();
    }

    // 6. Refresh Google Maps view
    setTimeout(() => {
      if (bookingGoogleMap) {
        google.maps.event.trigger(bookingGoogleMap, 'resize');
        updateBookingMap();
      }
    }, 80);
  }

  function updateTripTypeButtons() {
    const isReturn = bookingState.isReturnTrip !== false;
    if (step2TripSingleBtn) step2TripSingleBtn.classList.toggle('is-selected', !isReturn);
    if (step2TripReturnBtn) step2TripReturnBtn.classList.toggle('is-selected', isReturn);
    if (step2ReturnDurationSection) step2ReturnDurationSection.classList.toggle('is-hidden', !isReturn);

    // Sync legacy toggles if present
    if (toggleTripReturn) toggleTripReturn.classList.toggle('is-active', isReturn);
    if (toggleTripSingle) toggleTripSingle.classList.toggle('is-active', !isReturn);
  }

  function updateReviewSummary() {
    const isReturn = bookingState.isReturnTrip !== false;
    const waitMins = typeof bookingState.returnWaitMinutes === 'number' ? bookingState.returnWaitMinutes : 15;

    if (reviewPickupAddress) {
      reviewPickupAddress.textContent = (bookingState.pickup && bookingState.pickup.address) || '—';
    }
    if (reviewDropoffAddress) {
      reviewDropoffAddress.textContent = (bookingState.dropoff && bookingState.dropoff.address) || '—';
    }
    if (reviewTripTypeVal) {
      reviewTripTypeVal.textContent = isReturn
        ? `Return trip (${waitMins} min stop)`
        : 'Single trip (One way)';
    }
    if (reviewTripTypeIcon) {
      reviewTripTypeIcon.textContent = isReturn ? '🔄' : '➡️';
    }

    if (reviewRouteDistanceBadge) {
      const dist = bookingState.estimatedDistanceKm || (bookingState.actualOneWayDistanceKm ? (isReturn ? (bookingState.actualOneWayDistanceKm * 2).toFixed(1) : bookingState.actualOneWayDistanceKm.toFixed(1)) : '0');
      reviewRouteDistanceBadge.textContent = `📏 ~${dist} km`;
    }

    if (reviewRouteDurationBadge) {
      const durText = (bookingMapDuration && bookingMapDuration.textContent) || '0 min';
      reviewRouteDurationBadge.textContent = `⏱️ ~${durText}`;
    }

    updateUpfrontFarePreview(bookingState.actualOneWayDistanceKm);
  }

  /** Open Booking Form */
  function openBookingForm() {
    if (currentUser && !isProfileComplete) {
      showToast('Add your details to request a ride.');
      openProfileModal();
      return;
    }

    if (currentBookingDoc && ['PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'AT_DESTINATION', 'RETURN_TRIP'].includes(currentBookingDoc.status)) {
      showToast('You already have an active ride in progress.');
      openActiveTripModal();
      return;
    }

    bookingTargetDriver = null; // Quick Ride (Auto-Dispatch)

    if (bookingTargetTitle) bookingTargetTitle.textContent = 'Quick Ride Auto-Dispatch';
    if (bookingTargetSubtitle) bookingTargetSubtitle.textContent = 'Nearest available driver';
    if (bookingTargetTypeBadge) bookingTargetTypeBadge.textContent = 'Private Car';
    bookingState.vehicleType = 'PRIVATE_CAR';

    setReturnTrip(true);
    setBookingType('ASAP');

    bookingState.actualOneWayDistanceKm = null;
    bookingState.upfrontPrice = null;
    bookingState.estimatedDistanceKm = null;
    bookingState.pickup = { address: '', lat: null, lng: null };
    bookingState.dropoff = { address: '', lat: null, lng: null };

    if (pickupAddressInput) pickupAddressInput.value = '';
    if (pickupClearBtn) pickupClearBtn.classList.add('is-hidden');
    if (pickupGeofenceBadge) {
      pickupGeofenceBadge.className = 'geofence-badge';
      pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
    }
    if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');

    if (dropoffAddressInput) dropoffAddressInput.value = '';
    if (dropoffClearBtn) dropoffClearBtn.classList.add('is-hidden');
    if (dropoffErrorEl) dropoffErrorEl.classList.add('is-hidden');
    if (step2TripTypeSection) step2TripTypeSection.classList.add('is-hidden');

    if (bookingNoteInput) bookingNoteInput.value = '';
    if (bookingNoteCount) bookingNoteCount.textContent = '0/64';
    if (bookingFormError) bookingFormError.classList.add('is-hidden');

    // Reset to step 1
    setBookingStep(1);

    if (bookingModal) {
      bookingModal.classList.remove('is-hidden');
      updateUpfrontFarePreview(null);
      initBookingMap();
      setTimeout(() => updateBookingMap(), 150);
    }
  }

  function closeBookingModal() {
    if (bookingModal) bookingModal.classList.add('is-hidden');
  }

  /** Open / Close Android App Test Beta Modal */
  function openAppTestModal() {
    if (appTestModal) appTestModal.classList.remove('is-hidden');
  }

  function closeAppTestModal() {
    if (appTestModal) appTestModal.classList.add('is-hidden');
  }

  /** Set Trip Type (Return or Single) */
  function setReturnTrip(isReturn, autoAdvance = false) {
    bookingState.isReturnTrip = isReturn;
    updateTripTypeButtons();
    updateUpfrontFarePreview();

    // If single trip is chosen on Step 2 and autoAdvance is true, automatically advance to Step 3
    if (!isReturn && autoAdvance && currentBookingStep === 2) {
      setTimeout(() => {
        setBookingStep(3);
      }, 200);
    }
  }

  /** Set Return Expected Stop Duration in Minutes */
  function setReturnWaitMinutes(mins) {
    bookingState.returnWaitMinutes = mins;
    const chips = document.querySelectorAll('.wait-chip');
    chips.forEach((c) => {
      const m = parseInt(c.getAttribute('data-minutes'), 10);
      c.classList.toggle('is-active', m === mins);
    });
    updateUpfrontFarePreview();
  }

  /** Set Booking Type (ASAP on Web, or Route to Download App for SCHEDULED) */
  function setBookingType(type) {
    if (type === 'SCHEDULED') {
      window.location.href = 'download?feature=scheduled';
      return;
    }
    bookingState.type = 'ASAP';
    if (toggleTypeAsap) toggleTypeAsap.classList.add('is-active');
    if (toggleTypeScheduled) toggleTypeScheduled.classList.remove('is-active');
    if (scheduledFields) scheduledFields.classList.add('is-hidden');
  }

  /** Update pickup coordinates and validate geofence */
  function setPickupLocation(address, lat, lng, autoAdvance = true) {
    const trimmed = (address || '').trim();
    bookingState.actualOneWayDistanceKm = null;
    bookingState.upfrontPrice = null;
    bookingState.estimatedDistanceKm = null;
    bookingState.pickup = { address: trimmed, lat, lng };
    if (pickupAddressInput) pickupAddressInput.value = trimmed;
    if (pickupClearBtn) pickupClearBtn.classList.toggle('is-hidden', !trimmed);
    const allowed = validatePickupGeofence();
    updateBookingMap();

    // Auto advance to Step 2 if pickup is valid and autoAdvance is true
    if (allowed && trimmed && autoAdvance) {
      setTimeout(() => {
        setBookingStep(2);
        if (dropoffAddressInput) {
          dropoffAddressInput.focus();
        }
      }, 250);
    }
  }

  /** Update dropoff coordinates and show trip type prompt */
  function setDropoffLocation(address, lat, lng) {
    const trimmed = (address || '').trim();
    bookingState.actualOneWayDistanceKm = null;
    bookingState.upfrontPrice = null;
    bookingState.estimatedDistanceKm = null;
    bookingState.dropoff = { address: trimmed, lat, lng };
    if (dropoffAddressInput) dropoffAddressInput.value = trimmed;
    if (dropoffClearBtn) dropoffClearBtn.classList.toggle('is-hidden', !trimmed);
    if (dropoffErrorEl) dropoffErrorEl.classList.add('is-hidden');
    if (step2TripTypeSection) step2TripTypeSection.classList.remove('is-hidden');
    updateBookingMap();
  }

  /** Validate Pickup Geofence */
  function validatePickupGeofence() {
    const lat = bookingState.pickup ? bookingState.pickup.lat : null;
    const lng = bookingState.pickup ? bookingState.pickup.lng : null;

    if (lat == null || lng == null) {
      if (pickupGeofenceBadge) {
        pickupGeofenceBadge.className = 'geofence-badge';
        pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
      }
      if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
      return false;
    }

    const allowed = isPickupAllowed(lat, lng);

    if (pickupGeofenceBadge) {
      if (allowed) {
        pickupGeofenceBadge.className = 'geofence-badge is-valid';
        pickupGeofenceBadge.textContent = '🟢 Inside Service Area';
      } else {
        pickupGeofenceBadge.className = 'geofence-badge is-invalid';
        pickupGeofenceBadge.textContent = '🔴 Outside Service Area';
      }
    }

    if (pickupErrorEl) {
      if (!allowed) {
        pickupErrorEl.textContent = 'Pickup must be within the service area (within 176 km of centre).';
        pickupErrorEl.classList.remove('is-hidden');
      } else {
        pickupErrorEl.classList.add('is-hidden');
      }
    }

    return allowed;
  }

  /** Get GPS Current Position with comprehensive diagnostics, retry fallback, and reverse geocoding */
  async function getGpsLocation() {
    console.log('[GPS] ----------------------------------------------------');
    console.log('[GPS] Starting GPS location request...');
    console.log('[GPS] Environment diagnostics:', {
      hasNavigatorGeolocation: Boolean(navigator && navigator.geolocation),
      isSecureContext: window.isSecureContext,
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      userAgent: navigator.userAgent
    });

    if (!window.isSecureContext && window.location.protocol !== 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      console.warn('[GPS] ⚠️ Page is not running in a secure context (HTTPS/localhost). Geolocation is restricted by modern browsers.');
    }

    if (!navigator.geolocation) {
      console.error('[GPS] ❌ navigator.geolocation is not supported by this browser.');
      showToast('Geolocation is not supported by your browser.');
      return;
    }

    // Check Permissions API if available
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permStatus = await navigator.permissions.query({ name: 'geolocation' });
        console.log(`[GPS] Geolocation permission status: "${permStatus.state}"`);
        permStatus.onchange = () => {
          console.log(`[GPS] Geolocation permission changed to: "${permStatus.state}"`);
        };
      } catch (pErr) {
        console.log('[GPS] Could not query permission status via Permissions API:', pErr);
      }
    }

    if (pickupGpsBtn) {
      pickupGpsBtn.disabled = true;
      pickupGpsBtn.innerHTML = '<div class="spinner" style="width:14px;height:14px;"></div> Locating…';
    }

    function resetButton() {
      if (pickupGpsBtn) {
        pickupGpsBtn.disabled = false;
        pickupGpsBtn.innerHTML = '<span>📍</span> GPS';
      }
    }

    function handlePositionSuccess(pos, mode = 'high-accuracy') {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;
      const distToCenter = distanceMeters(SERVICE_AREA.center.lat, SERVICE_AREA.center.lng, lat, lng);
      const allowed = isPickupAllowed(lat, lng);

      console.log(`[GPS] ✅ Position acquired successfully (${mode}):`, {
        latitude: lat,
        longitude: lng,
        accuracyMeters: accuracy,
        distanceToPoortjieCenterMeters: distToCenter.toFixed(1),
        isInsidePoortjie: allowed,
        altitude: pos.coords.altitude,
        speed: pos.coords.speed,
        timestamp: pos.timestamp
      });

      // Attempt reverse geocoding with Google Maps Geocoder if loaded
      if (window.google && window.google.maps && window.google.maps.Geocoder) {
        console.log(`[GPS] Attempting reverse geocoding via Google Maps for (${lat}, ${lng})...`);
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat, lng } }, (results, status) => {
          console.log(`[GPS] Reverse geocode response status: ${status}`, results);
          if (status === 'OK' && results && results[0] && results[0].formatted_address) {
            const formattedAddr = results[0].formatted_address;
            console.log(`[GPS] Resolved address: "${formattedAddr}"`);
            setPickupLocation(formattedAddr, lat, lng);
          } else {
            const fallbackAddr = allowed ? 'Current Location' : 'Current Location (Outside Area)';
            console.log(`[GPS] Reverse geocoding unfulfilled, using fallback label: "${fallbackAddr}"`);
            setPickupLocation(fallbackAddr, lat, lng);
          }
          if (pickupClearBtn) pickupClearBtn.classList.remove('is-hidden');
          resetButton();
        });
      } else {
        const fallbackAddr = allowed ? 'Current Location' : 'Current Location (Outside Area)';
        console.log(`[GPS] Google Geocoder not loaded, using fallback label: "${fallbackAddr}"`);
        setPickupLocation(fallbackAddr, lat, lng);
        if (pickupClearBtn) pickupClearBtn.classList.remove('is-hidden');
        resetButton();
      }

      if (allowed) {
        showToast('📍 GPS location captured!');
      } else {
        showToast('⚠️ Your GPS location is outside the service area.');
      }
    }

    const highAccuracyOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };
    console.log('[GPS] Invoking navigator.geolocation.getCurrentPosition with high accuracy:', highAccuracyOptions);

    navigator.geolocation.getCurrentPosition(
      (pos) => handlePositionSuccess(pos, 'high-accuracy'),
      (err) => {
        const errorNames = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' };
        const errType = errorNames[err.code] || 'UNKNOWN_ERROR';
        console.warn(`[GPS] ⚠️ High-accuracy geolocation failed: code=${err.code} (${errType}), message="${err.message}"`);

        // If high accuracy timed out or was position unavailable, retry once with standard accuracy
        if (err.code === 3 || err.code === 2) {
          console.log('[GPS] Retrying with standard accuracy (enableHighAccuracy: false)...');
          const standardOptions = { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 };
          navigator.geolocation.getCurrentPosition(
            (pos) => handlePositionSuccess(pos, 'standard-accuracy-fallback'),
            (fallbackErr) => {
              const fallbackType = errorNames[fallbackErr.code] || 'UNKNOWN_ERROR';
              console.error(`[GPS] ❌ Standard-accuracy retry also failed: code=${fallbackErr.code} (${fallbackType}), message="${fallbackErr.message}"`);
              if (fallbackErr.code === 2) {
                console.info('[GPS] 💡 Tip for Mac / Chrome DevTools: macOS CoreLocation returned kCLErrorLocationUnknown. To resolve this:\n1. Enable macOS System Settings → Privacy & Security → Location Services → Google Chrome: ON (and ensure Wi-Fi is ON), OR\n2. In Chrome DevTools: Press Cmd+Shift+P → type "Sensors" → set Location to custom coordinates (e.g. Poortjie: Lat -26.57537, Lng 27.68133).');
              }
              resetButton();
              if (fallbackErr.code === 1) {
                showToast('Location permission denied. Please allow location access in your browser.');
              } else if (fallbackErr.code === 2) {
                showToast('GPS position unavailable on your device. Please search an address or check Location Services.');
              } else if (fallbackErr.code === 3) {
                showToast('GPS request timed out. Please search an address manually.');
              } else {
                showToast('Could not retrieve GPS location. Please search an address.');
              }
            },
            standardOptions
          );
        } else {
          resetButton();
          if (err.code === 1) {
            showToast('Location permission denied. Please allow location access in your browser.');
          } else {
            showToast('Could not retrieve GPS location. Please search an address.');
          }
        }
      },
      highAccuracyOptions
    );
  }

  /** Save pending booking state to sessionStorage before redirecting to login */
  function savePendingBookingState() {
    const pendingRide = {
      pickup: {
        address: (bookingState.pickup && bookingState.pickup.address) || (pickupAddressInput ? pickupAddressInput.value.trim() : ''),
        lat: bookingState.pickup ? bookingState.pickup.lat : null,
        lng: bookingState.pickup ? bookingState.pickup.lng : null
      },
      dropoff: {
        address: (bookingState.dropoff && bookingState.dropoff.address) || (dropoffAddressInput ? dropoffAddressInput.value.trim() : ''),
        lat: bookingState.dropoff ? bookingState.dropoff.lat : null,
        lng: bookingState.dropoff ? bookingState.dropoff.lng : null
      },
      note: bookingState.note || (bookingNoteInput ? bookingNoteInput.value.trim() : ''),
      vehicleType: bookingState.vehicleType || 'PRIVATE_CAR',
      isReturnTrip: bookingState.isReturnTrip !== false,
      returnWaitMinutes: bookingState.returnWaitMinutes || 15,
      waitPriceSnapshot: bookingState.waitPriceSnapshot,
      actualOneWayDistanceKm: bookingState.actualOneWayDistanceKm,
      estimatedDistanceKm: bookingState.estimatedDistanceKm,
      upfrontPrice: bookingState.upfrontPrice,
      ratePerKmSnapshot: bookingState.ratePerKmSnapshot,
      minimumFareSnapshot: bookingState.minimumFareSnapshot,
      curveScaleKmSnapshot: bookingState.curveScaleKmSnapshot,
      returnPercentSnapshot: bookingState.returnPercentSnapshot,
      targetDriverId: bookingTargetDriver ? bookingTargetDriver.uid : null
    };
    try {
      sessionStorage.setItem('pendingRideBooking', JSON.stringify(pendingRide));
    } catch (e) {
      console.warn('Could not store pendingRideBooking in sessionStorage:', e);
    }
  }

  /** Submit Booking */
  async function handleBookingSubmit(e) {
    if (e) e.preventDefault();
    if (bookingFormError) bookingFormError.classList.add('is-hidden');

    const pickupAddress = pickupAddressInput ? pickupAddressInput.value.trim() : '';
    if (!pickupAddress) {
      setBookingStep(1);
      if (pickupErrorEl) {
        pickupErrorEl.textContent = 'Please specify a pickup location.';
        pickupErrorEl.classList.remove('is-hidden');
      }
      return;
    }
    bookingState.pickup.address = pickupAddress;

    const dropoffAddress = dropoffAddressInput ? dropoffAddressInput.value.trim() : '';
    if (!dropoffAddress) {
      setBookingStep(2);
      if (dropoffErrorEl) {
        dropoffErrorEl.textContent = 'Please enter a drop-off destination.';
        dropoffErrorEl.classList.remove('is-hidden');
      }
      return;
    }
    bookingState.dropoff.address = dropoffAddress;

    // Geocode missing coordinates if user manually typed address without autocomplete
    if (global.google && global.google.maps && global.google.maps.Geocoder) {
      const geocoder = new google.maps.Geocoder();
      if (!bookingState.pickup.lat || !bookingState.pickup.lng) {
        try {
          const geoRes = await new Promise((resolve) => {
            geocoder.geocode({ address: pickupAddress, componentRestrictions: { country: 'za' } }, (results, status) => {
              if (status === 'OK' && results && results[0] && results[0].geometry) {
                resolve(results[0].geometry.location);
              } else {
                resolve(null);
              }
            });
          });
          if (geoRes) {
            bookingState.pickup.lat = geoRes.lat();
            bookingState.pickup.lng = geoRes.lng();
          }
        } catch (e) {
          console.warn('Geocoding pickup error:', e);
        }
      }

      if (!bookingState.dropoff.lat || !bookingState.dropoff.lng) {
        try {
          const geoRes = await new Promise((resolve) => {
            geocoder.geocode({ address: dropoffAddress, componentRestrictions: { country: 'za' } }, (results, status) => {
              if (status === 'OK' && results && results[0] && results[0].geometry) {
                resolve(results[0].geometry.location);
              } else {
                resolve(null);
              }
            });
          });
          if (geoRes) {
            bookingState.dropoff.lat = geoRes.lat();
            bookingState.dropoff.lng = geoRes.lng();
          }
        } catch (e) {
          console.warn('Geocoding dropoff error:', e);
        }
      }
    }

    if (!validatePickupGeofence()) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Pickup must be within the service area (within 176 km of centre).';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }

    if (bookingState.actualOneWayDistanceKm == null) {
      if (bookingFormError) {
        bookingFormError.textContent = 'Calculating driving route distance. Please wait a moment.';
        bookingFormError.classList.remove('is-hidden');
      }
      return;
    }

    bookingState.note = (bookingNoteInput ? bookingNoteInput.value.trim() : '');

    // If user is not signed in, save booking state and navigate to login
    if (!currentUser) {
      savePendingBookingState();
      sessionStorage.setItem('redirectUrl', window.location.href);
      window.location.href = '../../authentication/login?redirect=' + encodeURIComponent(window.location.href);
      return;
    }

    if (!isProfileComplete) {
      showToast('Add your details to request a ride.');
      closeBookingModal();
      openProfileModal(bookingTargetDriver ? bookingTargetDriver.uid : null);
      return;
    }

    // Open confirmation dialog showing ride details
    openConfirmBookingModal();
  }

  /** ============================================================
   * CONFIRMATION DIALOG & DISPATCH
   * ============================================================ */

  /** Open / Close Confirmation Dialog */
  function openConfirmBookingModal() {
    if (confirmModalError) confirmModalError.classList.add('is-hidden');

    const confirmFareText = document.getElementById('confirm-fare-text');
    if (confirmPickupText) confirmPickupText.textContent = bookingState.pickup.address || 'Pickup';
    if (confirmDropoffText) confirmDropoffText.textContent = bookingState.dropoff.address || 'Destination';
    if (confirmTripType) {
      confirmTripType.textContent = bookingState.isReturnTrip !== false ? 'Return Trip (Round trip)' : 'Single Trip (One way)';
    }
    if (confirmDistanceText) {
      const isReturn = bookingState.isReturnTrip !== false;
      const oneWay = bookingState.actualOneWayDistanceKm ? bookingState.actualOneWayDistanceKm.toFixed(1) : '—';
      confirmDistanceText.textContent = isReturn
        ? `${bookingState.estimatedDistanceKm || '—'} km (${oneWay} km return)`
        : `${bookingState.estimatedDistanceKm || '—'} km`;
    }

    const returnStopItem = document.getElementById('confirm-return-stop-item');
    const returnStopText = document.getElementById('confirm-return-stop-text');
    const isReturn = bookingState.isReturnTrip !== false;
    if (returnStopItem && returnStopText) {
      if (isReturn) {
        returnStopText.textContent = `Includes return trip & ~${bookingState.returnWaitMinutes || 15} min stop at destination`;
        returnStopItem.classList.remove('is-hidden');
      } else {
        returnStopItem.classList.add('is-hidden');
      }
    }

    if (confirmFareText) {
      confirmFareText.textContent = typeof bookingState.upfrontPrice === 'number' ? `R ${bookingState.upfrontPrice}` : 'R --';
    }
    if (confirmBookingSubmitBtn) {
      confirmBookingSubmitBtn.innerHTML = typeof bookingState.upfrontPrice === 'number'
        ? `<span>⚡</span> Confirm · R ${bookingState.upfrontPrice}`
        : '<span>⚡</span> Confirm';
    }

    const note = (bookingNoteInput ? bookingNoteInput.value.trim() : '');
    bookingState.note = note;
    if (confirmNoteContainer && confirmNoteText) {
      if (note) {
        confirmNoteText.textContent = note;
        confirmNoteContainer.classList.remove('is-hidden');
      } else {
        confirmNoteContainer.classList.add('is-hidden');
      }
    }

    if (confirmBookingModal) confirmBookingModal.classList.remove('is-hidden');
  }

  function closeConfirmBookingModal() {
    if (confirmBookingModal) confirmBookingModal.classList.add('is-hidden');
  }

  /** Create the booking and rider pointer atomically through the same API as Android. */
  async function handleConfirmBookingSubmit() {
    if (!currentUser) {
      savePendingBookingState();
      sessionStorage.setItem('redirectUrl', window.location.href);
      window.location.href = '../../authentication/login?redirect=' + encodeURIComponent(window.location.href);
      return;
    }

    if (confirmModalError) confirmModalError.classList.add('is-hidden');

    try {
      if (confirmBookingSubmitBtn) {
        confirmBookingSubmitBtn.disabled = true;
        confirmBookingSubmitBtn.innerHTML = '<div class="spinner" style="width:16px;height:16px;"></div> Requesting…';
      }

      const token = await currentUser.getIdToken();
      const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));
      const isReturn = bookingState.isReturnTrip !== false;
      const vehicleType = bookingState.vehicleType || 'PRIVATE_CAR';
      const pricingSnapshot = getPricingSnapshot(vehicleType);

      const pickup = {
        address: (bookingState.pickup && bookingState.pickup.address) || 'Current Location',
        lat: Number(bookingState.pickup && bookingState.pickup.lat),
        lng: Number(bookingState.pickup && bookingState.pickup.lng)
      };
      const dropoff = {
        address: (bookingState.dropoff && bookingState.dropoff.address) || 'Destination',
        lat: Number(bookingState.dropoff && bookingState.dropoff.lat),
        lng: Number(bookingState.dropoff && bookingState.dropoff.lng)
      };

      const fare = Number(bookingState.upfrontPrice || pricingSnapshot.minimumFare);
      const distanceKm = Number(bookingState.estimatedDistanceKm || bookingState.actualOneWayDistanceKm || 1);
      const durationSeconds = Math.round(Number(bookingState.durationSeconds || ((distanceKm / 40) * 3600) || 600));

      const payload = {
        requestId,
        pickup,
        dropoff,
        vehicleType,
        note: (bookingState.note || '').substring(0, 64),
        isReturnRide: isReturn,
        returnWaitMinutes: isReturn ? (Number(bookingState.returnWaitMinutes) || 15) : null,
        fare: Math.max(fare, pricingSnapshot.minimumFare),
        distanceKm: Math.max(distanceKm, 0.1),
        durationSeconds: Math.max(durationSeconds, 60),
        pricingSnapshot
      };

      const resp = await fetch('https://api.digilayn.co.za/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Layn-App': 'laynrider',
          'X-Layn-Environment': fleetEnvironment
        },
        body: JSON.stringify(payload)
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (json && json.error && (json.error.message || json.error.code)) || 'Failed to request ride.';
        throw new Error(msg);
      }

      const bookingId = json?.data?.bookingId;
      if (!bookingId) throw new Error('No booking ID returned from server.');

      const saved = await quickRequestsFor(currentUser.uid).doc(bookingId).get({ source: 'server' });
      if (saved.exists) {
        currentBookingDoc = { id: saved.id, ...saved.data() };
      }

      closeConfirmBookingModal();
      closeBookingModal();
      showToast('🎉 Ride requested! Finding your driver…');
      openActiveTripModal();
    } catch (err) {
      console.error('Failed to create booking:', err);
      if (confirmModalError) {
        confirmModalError.textContent = err.message || 'Failed to request ride. Please check your connection and try again.';
        confirmModalError.classList.remove('is-hidden');
      } else {
        showToast('Failed to request ride. Please try again.');
      }
    } finally {
      if (confirmBookingSubmitBtn) {
        confirmBookingSubmitBtn.disabled = false;
        confirmBookingSubmitBtn.innerHTML = '<span>⚡</span> Confirm';
      }
    }
  }

  /** ============================================================
   * LIVE QUOTE HANDSHAKE & TRIP TRACKING SCREEN
   * ============================================================ */

  /** Open / Close Active Trip Modal */
  function openActiveTripModal() {
    if (activeTripModal) activeTripModal.classList.remove('is-hidden');
    if (currentBookingDoc) renderActiveTripDetails(currentBookingDoc);
  }

  function closeActiveTripModal() {
    if (activeTripModal) activeTripModal.classList.add('is-hidden');
  }

  /** Start Live Active Booking Listener */
  function startActiveBookingListener(riderUid) {
    if (activeBookingUnsub) {
      activeBookingUnsub();
      activeBookingUnsub = null;
    }

    activeBookingUnsub = quickRequestsFor(riderUid)
      .onSnapshot(async (snap) => {
        if (!snap.empty) {
          const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

          const active = list.find(it => [
            'PENDING', 'ACCEPTED', 'SCHEDULED_CONFIRMED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'AT_DESTINATION', 'RETURN_TRIP'
          ].includes(it.status));

          const bookingToDisplay = active || list[0];
          const previousStatus = currentBookingDoc ? currentBookingDoc.status : null;
          currentBookingDoc = bookingToDisplay;

          const isLive = active != null;

          // Sound & Toast feedback on Direct Accept transitions
          if (bookingToDisplay.status === 'ACCEPTED' && previousStatus === 'PENDING') {
            playQuoteChime();
            showToast('🎉 Driver accepted your ride!');
            openActiveTripModal();
          } else if (bookingToDisplay.status === 'EN_ROUTE' && previousStatus !== 'EN_ROUTE') {
            showToast('🚗 Driver is on the way to pickup!');
          } else if (bookingToDisplay.status === 'ARRIVED' && previousStatus !== 'ARRIVED') {
            playQuoteChime();
            showToast('📍 Driver has arrived at your pickup location!');
          }

          // Update Dashboard Banner Widget
          renderActiveBookingBanner(bookingToDisplay, isLive);

          // Update Modal Details if open or if active action
          if (activeTripModal && !activeTripModal.classList.contains('is-hidden')) {
            await renderActiveTripDetails(bookingToDisplay);
          }
        } else {
          currentBookingDoc = null;
          if (activeBookingBanner) activeBookingBanner.classList.add('is-hidden');
          closeActiveTripModal();
        }
      }, (err) => {
        console.error('Error listening to active bookings:', err);
      });
  }

  function formatDeclineReason(raw) {
    if (!raw) return '';
    const clean = String(raw)
      .replace(/^Driver declined:\s*/i, '')
      .replace(/^Declined:\s*/i, '')
      .replace(/^Cancelled by driver:\s*/i, '')
      .replace(/^Cancelled by rider:\s*/i, '')
      .replace(/^Cancelled:\s*/i, '')
      .replace(/^Other:\s*/i, '')
      .trim();

    switch (clean.toUpperCase()) {
      case 'TOO_FAR':
        return 'Too far from pickup';
      case 'UNKNOWN_RIDER':
        return 'Unrecognized rider / safety concern';
      case 'VEHICLE_FULL':
        return 'Vehicle is currently full';
      case 'SCHEDULED_CONFLICT':
        return 'Scheduled ride conflict';
      case 'OTHER':
        return 'Driver is currently unavailable';
      case 'NO DRIVERS AVAILABLE':
      case 'NO_DRIVERS_AVAILABLE':
      case 'NO_DRIVERS':
      case 'NO_DRIVER':
      case 'NO DRIVER AVAILABLE':
        return 'No drivers available right now';
      case 'QUOTE APPROVAL TIMED OUT':
      case 'QUOTE_TIMEOUT':
      case 'QUOTE EXPIRED':
        return 'Quote approval timed out';
      case 'RIDER CHANGED PLANS':
      case 'RIDER_CHANGED_PLANS':
        return 'Rider changed plans';
      case 'RIDER NO-SHOW (WAITED 5 MINS)':
      case 'RIDER_NO_SHOW':
        return 'Rider did not show up';
      default:
        return clean;
    }
  }

  /**
   * Resolves the exact human-readable cancellation title, explanation, and badge icon
   * by inspecting booking status, cancelReason, cancelledByDriver, events, and dispatchMessage.
   */
  function getDetailedCancellationInfo(booking) {
    if (!booking) {
      return {
        title: 'Ride Request Ended',
        reason: 'Request ended without confirmation.',
        icon: '❌'
      };
    }

    const status = booking.status || 'CANCELLED';
    const rawReason = (booking.cancelReason || '').trim();
    const dispatchMsg = (booking.dispatchMessage || '').trim();
    const byDriver = booking.cancelledByDriver === true;
    const events = Array.isArray(booking.events) ? booking.events : [];

    // Check audit events for specific timeout or decline entries
    const timeoutEvent = [...events].reverse().find(e => e && (e.event === 'DRIVER_TIMEOUT' || e.event === 'TIMEOUT'));
    const declineEvent = [...events].reverse().find(e => e && e.event === 'DRIVER_DECLINED');
    const noDriverEvent = [...events].reverse().find(e => e && e.event === 'NO_DRIVER_AVAILABLE');

    // 1. Driver Declined during review (PRIORITIZED over generic fallback status)
    if (declineEvent || rawReason.toLowerCase().startsWith('declined:') || rawReason.toLowerCase().includes('declined') || (rawReason && ['TOO_FAR', 'VEHICLE_FULL', 'SCHEDULED_CONFLICT', 'UNKNOWN_RIDER'].includes(rawReason.toUpperCase()))) {
      const rawDetail = declineEvent?.detail ? declineEvent.detail.replace(/^Declined:\s*/i, '') : rawReason.replace(/^Declined:\s*/i, '');
      const declineDetail = formatDeclineReason(rawDetail);
      return {
        title: 'Request Declined',
        reason: declineDetail ? `Reason: ${declineDetail}` : 'The driver was unable to accept your request at this time.',
        icon: '🚫'
      };
    }

    // 2. Driver cancelled after accepting (Post-Acceptance / En Route / Arrived / In Trip)
    if (byDriver) {
      const readable = formatDeclineReason(rawReason);
      return {
        title: 'Driver Cancelled Ride',
        reason: readable ? `The driver had to cancel: "${readable}"` : 'The driver cancelled this ride after acceptance.',
        icon: '⚠️'
      };
    }

    // 3. Specific Driver or All Drivers Timed Out (didn't respond in 60s)
    if (status === 'DRIVER_UNAVAILABLE' && (timeoutEvent || rawReason.toLowerCase().includes('timed out') || rawReason.toLowerCase().includes('respond'))) {
      return {
        title: 'Driver Did Not Respond in Time',
        reason: 'The driver did not accept or respond within the 60-second window.',
        icon: '⏱️'
      };
    }

    // 4. Chosen driver is offline or busy
    if (status === 'DRIVER_UNAVAILABLE') {
      let detail = rawReason;
      if (!detail && timeoutEvent?.detail) detail = timeoutEvent.detail;
      if (!detail && dispatchMsg) detail = dispatchMsg;
      return {
        title: 'Driver Unavailable',
        reason: detail || 'The requested driver is currently offline or busy on another ride.',
        icon: '🚗'
      };
    }

    // 5. No drivers available in area / exhausted candidates
    if (status === 'CANCELLED_NO_DRIVER') {
      if (timeoutEvent) {
        return {
          title: 'Timed Out',
          reason: 'Nearby driver did not respond within the time limit. Please try requesting again.',
          icon: '⏱️'
        };
      }
      return {
        title: 'No Drivers Available',
        reason: rawReason || noDriverEvent?.detail || 'All available drivers are currently busy or offline. Please try again shortly.',
        icon: '📍'
      };
    }

    // 6. Quote Expired (rider did not approve within 60s)
    if (status === 'CANCELLED_EXPIRED') {
      return {
        title: 'Quote Expired',
        reason: 'The 60-second price quote approval window expired without confirmation.',
        icon: '⏱️'
      };
    }

    // 7. Rider Cancelled
    if (status === 'CANCELLED') {
      if (rawReason.toLowerCase().includes('no_show') || rawReason.toLowerCase().includes('no-show')) {
        return {
          title: 'Cancelled — Rider No-Show',
          reason: 'The driver waited 5 minutes at the pickup location but could not locate you.',
          icon: '📍'
        };
      }
      if (rawReason.toLowerCase().includes('scheduled')) {
        return {
          title: 'Scheduled Ride Cancelled',
          reason: rawReason || 'You cancelled this scheduled ride request.',
          icon: '📅'
        };
      }
      return {
        title: 'Ride Request Cancelled',
        reason: rawReason || 'You cancelled this ride request before confirmation.',
        icon: '✕'
      };
    }

    // Default fallback
    return {
      title: 'Ride Request Ended',
      reason: rawReason || dispatchMsg || 'Request ended without confirmation.',
      icon: '❌'
    };
  }

  /** Render Dashboard Active Booking Widget */
  function renderActiveBookingBanner(booking, isLive) {
    if (!activeBookingBanner) return;

    if (!isLive) {
      activeBookingBanner.classList.add('is-hidden');
      return;
    }

    activeBookingBanner.classList.remove('is-hidden');

    if (activeBookingIcon) {
      if (booking.status === 'ACCEPTED' || booking.status === 'EN_ROUTE') activeBookingIcon.textContent = '🚗';
      else if (booking.status === 'ARRIVED') activeBookingIcon.textContent = '📍';
      else if (booking.status === 'IN_TRIP') activeBookingIcon.textContent = '🚀';
      else if (['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(booking.status)) {
        const info = getDetailedCancellationInfo(booking);
        activeBookingIcon.textContent = info.icon;
      }
      else activeBookingIcon.textContent = '🚖';
    }

    if (activeBookingTitle) {
      if (booking.status === 'ACCEPTED') {
        const etaMins = booking.availabilityEtaMinutes || 5;
        activeBookingTitle.textContent = `Driver Accepted (ETA ~${etaMins}m)`;
      } else if (booking.status === 'SCHEDULED_CONFIRMED') {
        activeBookingTitle.textContent = 'Scheduled Ride Confirmed';
      } else if (booking.status === 'EN_ROUTE') {
        activeBookingTitle.textContent = 'Driver En Route';
      } else if (booking.status === 'ARRIVED') {
        activeBookingTitle.textContent = 'Driver Arrived!';
      } else if (booking.status === 'IN_TRIP') {
        activeBookingTitle.textContent = 'Trip in Progress';
      } else if (booking.status === 'AT_DESTINATION') {
        activeBookingTitle.textContent = 'Waiting at Stop';
      } else if (booking.status === 'RETURN_TRIP') {
        activeBookingTitle.textContent = 'Returning to Pickup';
      } else if (['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(booking.status)) {
        const info = getDetailedCancellationInfo(booking);
        activeBookingTitle.textContent = info.title;
      } else {
        activeBookingTitle.textContent = 'Finding your ride…';
      }
    }

    if (activeBookingStatusText) {
      if (['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(booking.status)) {
        const info = getDetailedCancellationInfo(booking);
        activeBookingStatusText.textContent = info.reason;
      } else {
        activeBookingStatusText.textContent = booking.dispatchMessage || formatBookingStatus(booking.status, booking);
      }
    }
  }

  function formatBookingStatus(status, booking = null) {
    if (booking && ['CANCELLED', 'CANCELLED_NO_DRIVER', 'DRIVER_UNAVAILABLE', 'CANCELLED_EXPIRED'].includes(status)) {
      const cancelInfo = getDetailedCancellationInfo(booking);
      return `${cancelInfo.title}: ${cancelInfo.reason}`;
    }
    switch (status) {
      case 'PENDING': return 'Finding your ride / Driver reviewing…';
      case 'QUOTED': return 'Quote received from driver.';
      case 'SCHEDULED_CONFIRMED': return 'Scheduled ride confirmed.';
      case 'ACCEPTED': return 'Driver accepted your ride.';
      case 'EN_ROUTE': return 'Driver is en route to pickup.';
      case 'ARRIVED': return 'Driver has arrived at pickup!';
      case 'IN_TRIP': return 'Heading to drop-off destination.';
      case 'AT_DESTINATION': return 'Waiting at stop.';
      case 'RETURN_TRIP': return 'Returning to pickup point.';
      case 'COMPLETED': return 'Trip completed!';
      case 'CANCELLED_NO_DRIVER': return 'No drivers responded in time.';
      case 'DRIVER_UNAVAILABLE': return 'Driver did not respond or declined.';
      case 'CANCELLED_EXPIRED': return 'Ride request expired.';
      case 'CANCELLED': return 'Ride request ended.';
      default: return status || 'In progress';
    }
  }

  /** Render Trip Tracking Details according to status */
  async function renderActiveTripDetails(booking) {
    if (!booking) return;

    if (trackBookingId) trackBookingId.textContent = `#${booking.id}`;

    // Reset all sections
    if (trackPendingSection) trackPendingSection.classList.add('is-hidden');
    if (trackActiveSection) trackActiveSection.classList.add('is-hidden');
    if (trackCompletedSection) trackCompletedSection.classList.add('is-hidden');
    if (trackCancelledSection) trackCancelledSection.classList.add('is-hidden');

    // Clear timers
    if (pendingTimerInterval) { clearInterval(pendingTimerInterval); pendingTimerInterval = null; }

    // Update Stepper
    updateTrackingStepper(booking.status);

    const status = booking.status || 'PENDING';

    if (status === 'PENDING') {
      // 1. Pending Section (Searching / Driver reviewing / Scheduled waiting)
      if (trackPendingSection) trackPendingSection.classList.remove('is-hidden');

      const isScheduled = booking.type === 'SCHEDULED';
      if (isScheduled) {
        if (pendingSectionTitle) pendingSectionTitle.textContent = 'Scheduled Ride Waiting';
        if (pendingSectionDesc) {
          if (booking.scheduledTime) {
            const schedDate = new Date(booking.scheduledTime);
            const dateStr = schedDate.toLocaleDateString('en-ZA', { month: 'short', day: 'numeric' });
            const timeStr = schedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            pendingSectionDesc.textContent = `Scheduled for ${dateStr} at ${timeStr}. Waiting in dispatch queue.`;
          } else {
            pendingSectionDesc.textContent = 'Your ride request is scheduled. Waiting for driver assignment.';
          }
        }
      } else {
        if (pendingSectionTitle) pendingSectionTitle.textContent = 'Finding your ride…';
        if (pendingSectionDesc) {
          pendingSectionDesc.textContent = booking.dispatchMessage || 'Driver is reviewing your request. Please hold on.';
        }
      }

      startPendingCountdown(booking);
      updateCancelPendingButton(booking);
    } else if (['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'AT_DESTINATION', 'RETURN_TRIP'].includes(status)) {
      // 2. Active En Route / Arrived / In Trip Section (Direct Accept)
      if (trackActiveSection) trackActiveSection.classList.remove('is-hidden');
      await renderDriverInfoForTracking(booking);
    } else if (status === 'COMPLETED') {
      // 3. Completed Section
      if (trackCompletedSection) trackCompletedSection.classList.remove('is-hidden');
      const finalFare = typeof booking.upfrontPrice === 'number'
        ? booking.upfrontPrice.toFixed(2)
        : (typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '0.00');
      const completedFareAmount = document.getElementById('completed-fare-amount');
      if (completedFareAmount) completedFareAmount.textContent = `R ${finalFare}`;

      const completedDistEl = document.getElementById('completed-distance-amount');
      if (completedDistEl) {
        const isReturn = booking.isReturnTrip !== false;
        completedDistEl.textContent = booking.estimatedDistanceKm
          ? `Distance: ${booking.estimatedDistanceKm} km${isReturn ? ' (Return)' : ''}`
          : 'Trip Done';
      }
    } else {
      // 4. Terminal Cancelled / Expired / No Driver
      if (trackCancelledSection) trackCancelledSection.classList.remove('is-hidden');
      const cancelInfo = getDetailedCancellationInfo(booking);
      if (cancelledIcon) cancelledIcon.textContent = cancelInfo.icon;
      if (cancelledTitle) cancelledTitle.textContent = cancelInfo.title;
      if (cancelledReasonText) cancelledReasonText.textContent = cancelInfo.reason;
    }
  }

  /** Update Stepper nodes (Direct Accept Model: Request -> Accepted -> En Route -> In Trip -> Done) */
  function updateTrackingStepper(status) {
    const steps = [
      { el: stepRequested, target: 'PENDING' },
      { el: stepAccepted, target: 'ACCEPTED' },
      { el: stepEnroute, target: 'EN_ROUTE' },
      { el: stepTrip, target: 'IN_TRIP' },
      { el: stepCompleted, target: 'COMPLETED' }
    ];

    const order = ['PENDING', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_TRIP', 'COMPLETED'];
    const currentIdx = order.indexOf(status === 'ARRIVED' ? 'EN_ROUTE' : status);

    steps.forEach((step, idx) => {
      if (!step.el) return;
      step.el.classList.remove('is-active', 'is-done');
      if (idx < currentIdx) {
        step.el.classList.add('is-done');
      } else if (idx === currentIdx) {
        step.el.classList.add('is-active');
      }
    });
  }

  /**
   * Update Pending Cancel Button state:
   * - ASAP: users CANNOT cancel when a driver is reviewing the request (deliveredAt != null, currentDriverId != null, or offerExpiresAt != null).
   * - SCHEDULED: users can ONLY cancel when 1 minute (60s) has passed on waiting.
   */
  function updateCancelPendingButton(booking) {
    if (!cancelPendingBtn || !booking) return;

    const isScheduled = booking.type === 'SCHEDULED';

    if (isScheduled) {
      const createdAt = readEpochMillis(booking.createdAt) || Date.now();
      const elapsedSec = Math.floor(Math.max(0, Date.now() - createdAt) / 1000);
      const waitThresholdSec = 60;

      if (elapsedSec < waitThresholdSec) {
        const remainingSec = waitThresholdSec - elapsedSec;
        cancelPendingBtn.disabled = true;
        cancelPendingBtn.textContent = `Cancel available in ${remainingSec}s`;
        cancelPendingBtn.title = `Scheduled requests can only be cancelled after waiting 1 minute. (${remainingSec}s remaining)`;
      } else {
        cancelPendingBtn.disabled = false;
        cancelPendingBtn.textContent = 'Cancel Request';
        cancelPendingBtn.title = 'Cancel this scheduled ride request';
      }
    } else {
      const isDriverReviewing = Boolean(
        booking.deliveredAt != null ||
        booking.currentDriverId != null ||
        booking.offerExpiresAt != null
      );

      if (isDriverReviewing) {
        cancelPendingBtn.disabled = true;
        cancelPendingBtn.textContent = 'Driver reviewing (cannot cancel)';
        cancelPendingBtn.title = 'A driver is currently reviewing your request. Please wait for their response or 60s timeout.';
      } else {
        cancelPendingBtn.disabled = false;
        cancelPendingBtn.textContent = 'Cancel Request';
        cancelPendingBtn.title = 'Cancel ride request';
      }
    }
  }

  /**
   * Pending countdown — display only, anchored to the server deadline
   * (booking.offerExpiresAt) or scheduled waiting elapsed time.
   * Also updates the cancel button countdown every second.
   */
  function startPendingCountdown(booking) {
    const deadline = readEpochMillis(booking.offerExpiresAt);
    const isScheduled = booking.type === 'SCHEDULED';
    const createdAt = readEpochMillis(booking.createdAt) || Date.now();

    function update() {
      // Dynamically update the cancel button (e.g. countdown 60s for scheduled, driver reviewing for ASAP)
      updateCancelPendingButton(booking);

      if (deadline != null) {
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        const formatted = formatTimerSeconds(remaining);
        if (pendingCountdown) pendingCountdown.textContent = formatted;
        if (pendingCountdownLabel) pendingCountdownLabel.textContent = '⏱️ Request timeout in:';
        if (activeBookingCountdownPill) {
          activeBookingCountdownPill.textContent = `⏱️ ${formatted}`;
          activeBookingCountdownPill.classList.remove('is-hidden');
        }
        if (remaining <= 0) {
          clearInterval(pendingTimerInterval);
          pendingTimerInterval = null;
          // Do not write status — the server transitions the booking.
        }
      } else if (isScheduled) {
        const elapsedSec = Math.floor(Math.max(0, Date.now() - createdAt) / 1000);
        if (pendingCountdownLabel) pendingCountdownLabel.textContent = '⏱️ Waiting time:';
        if (pendingCountdown) pendingCountdown.textContent = formatTimerSeconds(elapsedSec);
        if (activeBookingCountdownPill) {
          activeBookingCountdownPill.textContent = `📅 Waiting (${formatTimerSeconds(elapsedSec)})`;
          activeBookingCountdownPill.classList.remove('is-hidden');
        }
      } else {
        // No live offer yet (still searching). Show the server's message.
        if (pendingCountdownLabel) pendingCountdownLabel.textContent = '⏱️ Finding driver:';
        if (pendingCountdown) pendingCountdown.textContent = '…';
        if (activeBookingCountdownPill) activeBookingCountdownPill.classList.add('is-hidden');
      }
    }

    update();
    pendingTimerInterval = setInterval(update, 1000);
  }

  /** Render Driver Identity on Active Trip */
  async function renderDriverInfoForTracking(booking) {
    const driverUid = booking.driverId || booking.requestedDriverId;
    const userDoc = await getDriverIdentity(driverUid);
    const driverDoc = await getDriverRecord(driverUid);

    const v = driverDoc.vehicle || {};
    const name = userDoc.displayName || 'Driver';
    const phone = userDoc.phone || '';
    const avatar = userDoc.photoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=22c55e&color=fff&size=128`;

    if (trackDriverAvatar) trackDriverAvatar.src = avatar;
    if (trackDriverName) trackDriverName.textContent = name;
    if (trackVehicleDesc) {
      trackVehicleDesc.textContent = `${formatVehicleType(booking.vehicleType)} · ${v.make || 'Vehicle'} ${v.model || ''} (${v.colour || 'Standard'})`;
    }
    if (trackVehiclePlate) trackVehiclePlate.textContent = v.plate || '—';

    if (trackCallBtn) {
      trackCallBtn.href = phone ? `tel:${phone}` : '#';
      trackCallBtn.classList.toggle('is-hidden', !phone);
    }
    if (trackWhatsappBtn) {
      const cleanPhone = phone.startsWith('0') ? '27' + phone.substring(1) : phone;
      trackWhatsappBtn.href = phone ? `https://wa.me/${cleanPhone}?text=Hello%20${encodeURIComponent(name)}%2C%20this%20is%20your%20LaynRider%20passenger.` : '#';
      trackWhatsappBtn.classList.toggle('is-hidden', !phone);
    }

    if (trackStatusIcon && trackStatusTitle && trackStatusDesc) {
      if (booking.status === 'ACCEPTED') {
        const etaMins = booking.availabilityEtaMinutes || 5;
        trackStatusIcon.textContent = '✅';
        trackStatusTitle.textContent = `Driver Accepted (ETA ~${etaMins}m)`;
        trackStatusDesc.textContent = `${name} is preparing to head your way.`;
      } else if (booking.status === 'EN_ROUTE') {
        const etaMins = booking.availabilityEtaMinutes || 5;
        const arrivalDate = new Date(Date.now() + etaMins * 60 * 1000);
        const hh = String(arrivalDate.getHours()).padStart(2, '0');
        const mm = String(arrivalDate.getMinutes()).padStart(2, '0');
        trackStatusIcon.textContent = '🚗';
        trackStatusTitle.textContent = `Driver is En Route (ETA ~${etaMins}m · ${hh}:${mm})`;
        trackStatusDesc.textContent = `${name} is on the way to pickup.`;
      } else if (booking.status === 'ARRIVED') {
        trackStatusIcon.textContent = '📍';
        trackStatusTitle.textContent = 'Driver has Arrived!';
        trackStatusDesc.textContent = `Please meet ${name} at your pickup location.`;
      } else if (booking.status === 'IN_TRIP') {
        trackStatusIcon.textContent = '🚀';
        trackStatusTitle.textContent = 'Trip in Progress';
        trackStatusDesc.textContent = 'Headed safely to your drop-off destination.';
      }
    }

    if (trackPickupText) trackPickupText.textContent = booking.pickup?.address || 'Pickup';
    if (trackDropoffText) trackDropoffText.textContent = booking.dropoff?.address || 'Destination';
    const trackFareAmount = document.getElementById('track-fare-amount');
    if (trackFareAmount) {
      const price = typeof booking.upfrontPrice === 'number'
        ? booking.upfrontPrice.toFixed(2)
        : (typeof booking.quotedPrice === 'number' ? booking.quotedPrice.toFixed(2) : '—');
      trackFareAmount.textContent = `R ${price}`;
    }
    const trackDistanceVal = document.getElementById('track-distance-val');
    if (trackDistanceVal) {
      const isReturn = booking.isReturnTrip !== false;
      trackDistanceVal.textContent = booking.estimatedDistanceKm
        ? `${booking.estimatedDistanceKm} km${isReturn ? ' (Return)' : ''}`
        : '—';
    }

    if (activeBookingCountdownPill) {
      activeBookingCountdownPill.classList.add('is-hidden');
    }

    initTrackingMap();
    setTimeout(() => {
      updateTrackingMap(booking);
    }, 150);
  }

  /** Cancel Pending Request → server (cancelBookingCallable). */
  async function handleCancelPending() {
    if (!currentBookingDoc) return;

    const isScheduled = currentBookingDoc.type === 'SCHEDULED';
    if (isScheduled) {
      const createdAt = readEpochMillis(currentBookingDoc.createdAt) || Date.now();
      const elapsedSec = Math.floor(Math.max(0, Date.now() - createdAt) / 1000);
      if (elapsedSec < 60) {
        const remaining = 60 - elapsedSec;
        showToast(`Scheduled rides can only be cancelled after waiting 1 minute (${remaining}s remaining).`);
        return;
      }
    } else {
      const isDriverReviewing = Boolean(
        currentBookingDoc.deliveredAt != null ||
        currentBookingDoc.currentDriverId != null ||
        currentBookingDoc.offerExpiresAt != null
      );
      if (isDriverReviewing) {
        showToast('Cannot cancel while a driver is reviewing your request.');
        return;
      }
    }

    try {
      if (cancelPendingBtn) cancelPendingBtn.disabled = true;
      await riderApi.request('POST', `/bookings/${currentBookingDoc.id}/cancel`, {
        actionId: global.crypto.randomUUID(),
        reason: isScheduled
          ? 'Cancelled by rider after 1 min scheduled wait.'
          : 'Cancelled by rider before dispatch confirmation.',
      });
      showToast('Ride request cancelled.');
    } catch (err) {
      console.error('Failed to cancel ride:', err);
      showToast('Could not cancel ride.');
    } finally {
      if (cancelPendingBtn && currentBookingDoc) {
        updateCancelPendingButton(currentBookingDoc);
      }
    }
  }

  /** Submit Rating and Done (mirrors Android FirestoreRatingRepository). */
  async function handleCompletedDone() {
    if (completedDoneBtn) completedDoneBtn.disabled = true;

    if (currentBookingDoc && currentBookingDoc.status === 'COMPLETED') {
      const driverUid = currentBookingDoc.driverId || currentBookingDoc.requestedDriverId;
      const comment = tripReviewComment ? tripReviewComment.value.trim() : '';

      if (driverUid) {
        try {
          const existing = await ratingsCol
            .where('tripId', '==', currentBookingDoc.id)
            .where('byUid', '==', currentUser.uid)
            .limit(1)
            .get();

          if (existing.empty) {
            await riderApi.request('POST', '/ratings', {
              tripId: currentBookingDoc.id,
              stars: selectedStars,
              review: comment,
            });
            driverReviewsCache.delete(driverUid);
          } else {
            const existingDoc = existing.docs[0];
            const existingData = existingDoc.data();
            const elapsed = Date.now() - (existingData.createdAt || 0);
            if (elapsed <= 60000) {
              await riderApi.request('PATCH', `/ratings/${existingDoc.id}`, {
                review: comment,
              });
              driverReviewsCache.delete(driverUid);
            }
          }
        } catch (e) {
          console.warn('Error saving rating:', e);
          showToast(e.message || 'Your rating could not be saved. Please try again.');
          if (completedDoneBtn) completedDoneBtn.disabled = false;
          return;
        }
      }
    }

    showToast('Thank you for your rating!');
    setTimeout(() => {
      if (completedDoneBtn) completedDoneBtn.disabled = false;
      closeActiveTripModal();
    }, 1000);
  }

  /** Resume pending booking saved in sessionStorage before login */
  function checkAndResumePendingBooking() {
    let pendingRaw = null;
    try {
      pendingRaw = sessionStorage.getItem('pendingRideBooking');
    } catch (e) {
      console.warn('Could not read pendingRideBooking from sessionStorage:', e);
    }
    if (!pendingRaw) return;

    let pendingRide = null;
    try {
      pendingRide = JSON.parse(pendingRaw);
    } catch (e) {
      console.warn('Could not parse pendingRideBooking:', e);
      sessionStorage.removeItem('pendingRideBooking');
      return;
    }

    if (!pendingRide || !pendingRide.pickup || !pendingRide.dropoff) {
      sessionStorage.removeItem('pendingRideBooking');
      return;
    }

    // Restore booking state
    bookingState.pickup = pendingRide.pickup || { address: '', lat: null, lng: null };
    bookingState.dropoff = pendingRide.dropoff || { address: '', lat: null, lng: null };
    bookingState.note = pendingRide.note || '';
    bookingState.vehicleType = pendingRide.vehicleType || 'PRIVATE_CAR';
    bookingState.isReturnTrip = pendingRide.isReturnTrip !== false;
    bookingState.actualOneWayDistanceKm = pendingRide.actualOneWayDistanceKm || null;
    bookingState.estimatedDistanceKm = pendingRide.estimatedDistanceKm || null;
    bookingState.upfrontPrice = pendingRide.upfrontPrice || null;
    bookingState.ratePerKmSnapshot = pendingRide.ratePerKmSnapshot || null;
    bookingState.minimumFareSnapshot = pendingRide.minimumFareSnapshot || null;
    bookingState.returnPercentSnapshot = pendingRide.returnPercentSnapshot || null;
    bookingTargetDriver = pendingRide.targetDriverId ? { uid: pendingRide.targetDriverId } : null;

    // Populate UI inputs
    if (pickupAddressInput) pickupAddressInput.value = bookingState.pickup.address || '';
    if (dropoffAddressInput) dropoffAddressInput.value = bookingState.dropoff.address || '';
    if (bookingNoteInput) bookingNoteInput.value = bookingState.note || '';
    if (bookingNoteCount) bookingNoteCount.textContent = `${(bookingState.note || '').length}/64`;
    if (pickupClearBtn) pickupClearBtn.classList.toggle('is-hidden', !bookingState.pickup.address);
    if (dropoffClearBtn) dropoffClearBtn.classList.toggle('is-hidden', !bookingState.dropoff.address);

    setReturnTrip(bookingState.isReturnTrip);
    validatePickupGeofence();
    updateUpfrontFarePreview(bookingState.actualOneWayDistanceKm);

    // If profile is NOT complete, prompt user to complete profile details first
    if (!isProfileComplete) {
      showToast('Please complete your profile to continue with your ride booking.', 4000);
      openProfileModal(pendingRide.targetDriverId || null);
    } else {
      // Profile is complete! Automatically open confirmation dialog to continue booking
      sessionStorage.removeItem('pendingRideBooking');
      showToast('Continuing with your ride request...', 3000);
      setTimeout(() => {
        openConfirmBookingModal();
      }, 300);
    }
  }

  /** Render user state */
  async function renderUserState(authUser, profileData) {
    if (!authUser) {
      currentUser = null;
      userProfile = null;
      isProfileComplete = false;
      if (presenceUnsub) { presenceUnsub(); presenceUnsub = null; }
      rtdbPresence = {};
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      if (activeScheduledUnsub) { activeScheduledUnsub(); activeScheduledUnsub = null; }
      if (activePlannedListingsUnsub) { activePlannedListingsUnsub(); activePlannedListingsUnsub = null; }
      if (activePlannedRequestsUnsub) { activePlannedRequestsUnsub(); activePlannedRequestsUnsub = null; }
      availablePlannedPlans = [];
      myPlannedRequests = [];
      updatePlannedRideDisplay();

      if (headerSignInBtn) headerSignInBtn.classList.remove('is-hidden');
      if (headerUserBtn) headerUserBtn.classList.add('is-hidden');
      if (headerSignOutBtn) headerSignOutBtn.classList.add('is-hidden');

      if (heroNameEl) heroNameEl.textContent = 'rider';
      if (activeBookingBanner) activeBookingBanner.classList.add('is-hidden');

      showView('auth');
      return;
    }

    currentUser = authUser;
    userProfile = profileData || {};

    if (userProfile.suspended === true) {
      const reasonEl = document.getElementById('suspended-reason-text');
      if (reasonEl) {
        reasonEl.textContent = userProfile.suspendedReason || 'Account suspended by management.';
      }
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      if (activeScheduledUnsub) { activeScheduledUnsub(); activeScheduledUnsub = null; }
      if (activePlannedListingsUnsub) { activePlannedListingsUnsub(); activePlannedListingsUnsub = null; }
      if (activePlannedRequestsUnsub) { activePlannedRequestsUnsub(); activePlannedRequestsUnsub = null; }
      availablePlannedPlans = [];
      myPlannedRequests = [];
      updatePlannedRideDisplay();
      showView('suspended');
      return;
    }

    // Terms & Privacy consent gate
    const hasConsent = await checkLaynFleetConsent(authUser.uid);
    if (!hasConsent) {
      showView('terms');
      return;
    }

    // Profile completeness gate
    const completeness = checkProfileCompleteness(userProfile, authUser);
    isProfileComplete = completeness.isComplete;
    if (!isProfileComplete) {
      renderMissingProfileDetails(completeness.missing);
      showView('profile-gate');
      return;
    }

    const displayName = completeness.name || authUser.email || 'Rider';
    const firstName = (displayName.split(' ')[0]) || 'Rider';
    if (headerUserName) headerUserName.textContent = firstName;
    if (heroNameEl) heroNameEl.textContent = firstName;
    if (headerAvatar) {
      if (completeness.photo) {
        headerAvatar.src = completeness.photo;
        headerAvatar.classList.remove('is-hidden');
      } else {
        headerAvatar.src = 'https://placehold.co/100x100/22c55e/ffffff?text=' + encodeURIComponent(displayName[0] || 'R');
      }
    }

    showView('app');
    if (!presenceUnsub) {
      const presenceRef = rtdb.ref(RTDB_LOCATIONS);
      const onPresence = snapshot => {
        rtdbPresence = snapshot.val() || {};
        if (currentBookingDoc) updateTrackingMap(currentBookingDoc);
      };
      presenceRef.on('value', onPresence, error => {
        rtdbPresence = {};
        console.warn('Driver presence unavailable:', error);
        if (currentBookingDoc) updateTrackingMap(currentBookingDoc);
      });
      presenceUnsub = () => presenceRef.off('value', onPresence);
    }
    startActiveBookingListener(authUser.uid);
    initScheduledRidesListener(authUser.uid);
    initPlannedRidesListener(authUser.uid);

    // Check if there is a pending ride booking from before login
    checkAndResumePendingBooking();
  }

  /** Sign Out */
  async function handleSignOut() {
    try {
      await riderApi.signOut();
      if (activeBookingUnsub) { activeBookingUnsub(); activeBookingUnsub = null; }
      if (activeScheduledUnsub) { activeScheduledUnsub(); activeScheduledUnsub = null; }
      if (activePlannedListingsUnsub) { activePlannedListingsUnsub(); activePlannedListingsUnsub = null; }
      if (activePlannedRequestsUnsub) { activePlannedRequestsUnsub(); activePlannedRequestsUnsub = null; }
      availablePlannedPlans = [];
      myPlannedRequests = [];
      updatePlannedRideDisplay();
      if (typeof AuthStore !== 'undefined' && AuthStore.signOut) {
        await AuthStore.signOut();
      } else {
        await auth.signOut();
      }
      showToast('Signed out');
      window.top.location.replace('../../authentication/login');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  }

  /** Event Listeners */
  function initListeners() {
    if (headerSignOutBtn) headerSignOutBtn.addEventListener('click', handleSignOut);
    const suspendedSignOutBtn = document.getElementById('suspended-signout-btn');
    if (suspendedSignOutBtn) suspendedSignOutBtn.addEventListener('click', handleSignOut);

    if (headerUserBtn) headerUserBtn.addEventListener('click', navigateToProfile);
    if (profileGateCompleteBtn) profileGateCompleteBtn.addEventListener('click', navigateToProfile);

    // Terms Gate Checkbox and Continue
    if (termsAcceptCheckbox) {
      termsAcceptCheckbox.addEventListener('change', () => {
        if (termsContinueBtn) termsContinueBtn.disabled = !termsAcceptCheckbox.checked;
      });
    }
    if (termsContinueBtn) {
      termsContinueBtn.addEventListener('click', async () => {
        if (!currentUser || !termsAcceptCheckbox?.checked) return;
        try {
          termsContinueBtn.disabled = true;
          termsContinueBtn.innerHTML = '<div class="spinner"></div> Saving…';
          if (termsGateError) termsGateError.classList.add('is-hidden');
          await saveLaynFleetConsent(currentUser.uid);
          await renderUserState(currentUser, userProfile);
        } catch (e) {
          console.error('[LaynRider] Failed to save terms consent:', e);
          if (termsGateError) {
            termsGateError.textContent = 'Could not record consent. Please try again.';
            termsGateError.classList.remove('is-hidden');
          }
          termsContinueBtn.disabled = false;
          termsContinueBtn.textContent = 'Continue';
        }
      });
    }

    // Quick Ride Cards
    if (quickRideBtn) quickRideBtn.addEventListener('click', () => openBookingForm());
    if (heroQuickCard) heroQuickCard.addEventListener('click', (e) => {
      if (e.target !== quickRideBtn && !quickRideBtn?.contains(e.target)) openBookingForm();
    });

    // Scheduled Ride Cards & Modals
    if (scheduledInviteCard) scheduledInviteCard.addEventListener('click', openScheduleModal);
    if (scheduledActiveCard) scheduledActiveCard.addEventListener('click', openScheduledDetailsModal);
    if (scheduledViewDetailsBtn) {
      scheduledViewDetailsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openScheduledDetailsModal();
      });
    }
    if (scheduleModalClose) scheduleModalClose.addEventListener('click', closeScheduleModal);
    if (scheduleModalCancel) scheduleModalCancel.addEventListener('click', closeScheduleModal);
    if (scheduleSubmitBtn) scheduleSubmitBtn.addEventListener('click', handleScheduleSubmit);
    if (scheduledDetailsClose) scheduledDetailsClose.addEventListener('click', closeScheduledDetailsModal);
    if (scheduledDetailsDismiss) scheduledDetailsDismiss.addEventListener('click', closeScheduledDetailsModal);
    if (scheduledCancelBtn) scheduledCancelBtn.addEventListener('click', handleCancelScheduledRide);

    // Scheduled Trip Type Toggle
    if (scheduleTypeOneway) {
      scheduleTypeOneway.addEventListener('click', () => {
        scheduleTypeOneway.classList.add('is-active');
        if (scheduleTypeReturn) scheduleTypeReturn.classList.remove('is-active');
        if (scheduleReturnOptions) scheduleReturnOptions.classList.add('is-hidden');
        scheduleState.tripType = 'ONE_WAY';
        updateScheduleFareEstimate();
      });
    }
    if (scheduleTypeReturn) {
      scheduleTypeReturn.addEventListener('click', () => {
        scheduleTypeReturn.classList.add('is-active');
        if (scheduleTypeOneway) scheduleTypeOneway.classList.remove('is-active');
        if (scheduleReturnOptions) scheduleReturnOptions.classList.remove('is-hidden');
        scheduleState.tripType = 'RETURN';
        updateScheduleFareEstimate();
      });
    }
    const scheduleWaitPills = document.querySelectorAll('#schedule-return-options .wait-pill');
    scheduleWaitPills.forEach(pill => {
      pill.addEventListener('click', () => {
        scheduleWaitPills.forEach(p => p.classList.remove('is-active'));
        pill.classList.add('is-active');
        scheduleState.returnWaitMinutes = parseInt(pill.getAttribute('data-mins'), 10) || 15;
        updateScheduleFareEstimate();
      });
    });

    if (schedulePickupGpsBtn) {
      schedulePickupGpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
          showToast('Geolocation is not supported by your browser.');
          return;
        }
        schedulePickupGpsBtn.disabled = true;
        schedulePickupGpsBtn.textContent = '…';
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            schedulePickupGpsBtn.disabled = false;
            schedulePickupGpsBtn.textContent = '📍 GPS';
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            if (global.google && global.google.maps) {
              const geocoder = new google.maps.Geocoder();
              geocoder.geocode({ location: { lat, lng } }, (results, status) => {
                const addr = (status === 'OK' && results[0]) ? results[0].formatted_address : `GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                scheduleState.pickup = { address: addr, lat, lng };
                if (schedulePickupInput) schedulePickupInput.value = addr;
                updateScheduleFareEstimate();
              });
            } else {
              const addr = `GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
              scheduleState.pickup = { address: addr, lat, lng };
              if (schedulePickupInput) schedulePickupInput.value = addr;
              updateScheduleFareEstimate();
            }
          },
          (err) => {
            schedulePickupGpsBtn.disabled = false;
            schedulePickupGpsBtn.textContent = '📍 GPS';
            showToast('Could not fetch GPS location.');
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    }

    // Planned Ride Card & Modals
    if (plannedRideCard) {
      plannedRideCard.addEventListener('click', () => {
        if (myPlannedRequests.length > 0) {
          openPlannedBookingDetailsModal(myPlannedRequests[0]);
        } else {
          const unbookedCommunityPlans = availablePlannedPlans.filter(p =>
            !myPlannedRequests.some(r => r.planId === p.id || r.id === p.id)
          );
          if (unbookedCommunityPlans.length > 0) {
            openPlannedReserveModal(unbookedCommunityPlans[0]);
          } else {
            openPlannedModal();
          }
        }
      });
    }

    // Planned card role action buttons
    if (plannedCardBtnTagAlong) {
      plannedCardBtnTagAlong.addEventListener('click', (e) => {
        e.stopPropagation();
        const unbooked = availablePlannedPlans.filter(p => !myPlannedRequests.some(r => r.planId === p.id || r.id === p.id));
        if (unbooked.length > 0) openPlannedReserveModal(unbooked[0], 'PASSENGER');
        else openPlannedModal();
      });
    }
    if (plannedCardBtnDeliver) {
      plannedCardBtnDeliver.addEventListener('click', (e) => {
        e.stopPropagation();
        const unbooked = availablePlannedPlans.filter(p => !myPlannedRequests.some(r => r.planId === p.id || r.id === p.id));
        if (unbooked.length > 0) openPlannedReserveModal(unbooked[0], 'DELIVER');
        else openPlannedModal();
      });
    }
    if (plannedCardBtnFetch) {
      plannedCardBtnFetch.addEventListener('click', (e) => {
        e.stopPropagation();
        const unbooked = availablePlannedPlans.filter(p => !myPlannedRequests.some(r => r.planId === p.id || r.id === p.id));
        if (unbooked.length > 0) openPlannedReserveModal(unbooked[0], 'FETCH');
        else openPlannedModal();
      });
    }

    // Planned modal role toggle buttons
    if (plannedRolePassenger) {
      plannedRolePassenger.addEventListener('click', () => selectPlannedRole('PASSENGER'));
    }
    if (plannedRoleDeliver) {
      plannedRoleDeliver.addEventListener('click', () => selectPlannedRole('DELIVER'));
    }
    if (plannedRoleFetch) {
      plannedRoleFetch.addEventListener('click', () => selectPlannedRole('FETCH'));
    }

    if (plannedModalClose) plannedModalClose.addEventListener('click', closePlannedModal);
    if (plannedModalDoneBtn) plannedModalDoneBtn.addEventListener('click', closePlannedModal);

    // Planned Reserve Modal Listeners
    if (plannedReserveClose) plannedReserveClose.addEventListener('click', closePlannedReserveModal);
    if (plannedReserveCancelBtn) plannedReserveCancelBtn.addEventListener('click', closePlannedReserveModal);
    if (plannedReserveSubmitBtn) plannedReserveSubmitBtn.addEventListener('click', handlePlannedReserveSubmit);
    if (plannedReservePickupGpsBtn) {
      plannedReservePickupGpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
          showToast('Geolocation is not supported by your browser.');
          return;
        }
        plannedReservePickupGpsBtn.disabled = true;
        plannedReservePickupGpsBtn.textContent = '…';
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            plannedReservePickupGpsBtn.disabled = false;
            plannedReservePickupGpsBtn.textContent = '📍 GPS';
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            if (global.google && global.google.maps) {
              const geocoder = new google.maps.Geocoder();
              geocoder.geocode({ location: { lat, lng } }, (results, status) => {
                const addr = (status === 'OK' && results[0]) ? results[0].formatted_address : `GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                reservePickupLocation = { address: addr, lat, lng };
                if (plannedReservePickupInput) plannedReservePickupInput.value = addr;
              });
            } else {
              const addr = `GPS (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
              reservePickupLocation = { address: addr, lat, lng };
              if (plannedReservePickupInput) plannedReservePickupInput.value = addr;
            }
          },
          (err) => {
            plannedReservePickupGpsBtn.disabled = false;
            plannedReservePickupGpsBtn.textContent = '📍 GPS';
            showToast('Could not fetch GPS location.');
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    }

    // Planned Booking Details Modal Listeners
    if (plannedBookingClose) plannedBookingClose.addEventListener('click', closePlannedBookingDetailsModal);
    if (plannedBookingDismissBtn) plannedBookingDismissBtn.addEventListener('click', closePlannedBookingDetailsModal);
    if (plannedBookingWithdrawBtn) plannedBookingWithdrawBtn.addEventListener('click', handlePlannedWithdraw);

    // Quick Ride
    if (quickRideBtn) quickRideBtn.addEventListener('click', () => openBookingForm());

    // Booking Modal
    if (bookingModalClose) bookingModalClose.addEventListener('click', closeBookingModal);
    if (bookingModalCancel) bookingModalCancel.addEventListener('click', closeBookingModal);
    if (bookingForm) bookingForm.addEventListener('submit', handleBookingSubmit);

    // Modal Back Button Navigation
    if (bookingModalBack) {
      bookingModalBack.addEventListener('click', () => {
        if (currentBookingStep === 3) {
          setBookingStep(2);
        } else if (currentBookingStep === 2) {
          setBookingStep(1);
        } else {
          closeBookingModal();
        }
      });
    }

    // Stepper Indicators
    if (bookingStepIndicator1) {
      bookingStepIndicator1.addEventListener('click', () => setBookingStep(1));
    }
    if (bookingStepIndicator2) {
      bookingStepIndicator2.addEventListener('click', () => {
        if (bookingState.pickup && bookingState.pickup.address) setBookingStep(2);
      });
    }
    if (bookingStepIndicator3) {
      bookingStepIndicator3.addEventListener('click', () => {
        if (bookingState.pickup && bookingState.pickup.address && bookingState.dropoff && bookingState.dropoff.address) {
          setBookingStep(3);
        }
      });
    }

    // Step 2 & 3 Edit Navigation Buttons
    if (step2ChangePickupBtn) step2ChangePickupBtn.addEventListener('click', () => setBookingStep(1));
    if (reviewEditPickupBtn) reviewEditPickupBtn.addEventListener('click', () => setBookingStep(1));
    if (reviewEditDropoffBtn) reviewEditDropoffBtn.addEventListener('click', () => setBookingStep(2));
    if (reviewEditTypeBtn) reviewEditTypeBtn.addEventListener('click', () => setBookingStep(2));

    // Step 2 Trip Choice Cards (Single vs Return)
    if (step2TripSingleBtn) {
      step2TripSingleBtn.addEventListener('click', () => {
        setReturnTrip(false, true);
      });
    }
    if (step2TripReturnBtn) {
      step2TripReturnBtn.addEventListener('click', () => {
        setReturnTrip(true, false);
      });
    }
    if (step2ReturnContinueBtn) {
      step2ReturnContinueBtn.addEventListener('click', () => {
        setBookingStep(3);
      });
    }

    // Trip Type Toggles (Legacy sync)
    if (toggleTripReturn) toggleTripReturn.addEventListener('click', () => setReturnTrip(true));
    if (toggleTripSingle) toggleTripSingle.addEventListener('click', () => setReturnTrip(false, true));

    // Return Wait Chips
    const waitChips = document.querySelectorAll('.wait-chip');
    waitChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const mins = parseInt(chip.getAttribute('data-minutes'), 10) || 15;
        setReturnWaitMinutes(mins);
      });
    });

    // Ride Type Toggles
    if (toggleTypeAsap) toggleTypeAsap.addEventListener('click', () => setBookingType('ASAP'));
    if (toggleTypeScheduled) toggleTypeScheduled.addEventListener('click', () => setBookingType('SCHEDULED'));

    // GPS Pickup
    if (pickupGpsBtn) pickupGpsBtn.addEventListener('click', getGpsLocation);

    // Clear Pickup Input Button
    if (pickupClearBtn) {
      pickupClearBtn.addEventListener('click', () => {
        if (pickupAddressInput) {
          pickupAddressInput.value = '';
          pickupAddressInput.focus();
        }
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.pickup = { address: '', lat: null, lng: null };
        pickupClearBtn.classList.add('is-hidden');
        if (pickupGeofenceBadge) {
          pickupGeofenceBadge.className = 'geofence-badge';
          pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
        }
        if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
        updateBookingMap();
      });
    }

    // Clear Drop-off Input Button
    if (dropoffClearBtn) {
      dropoffClearBtn.addEventListener('click', () => {
        if (dropoffAddressInput) {
          dropoffAddressInput.value = '';
          dropoffAddressInput.focus();
        }
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.dropoff = { address: '', lat: null, lng: null };
        dropoffClearBtn.classList.add('is-hidden');
        updateBookingMap();
      });
    }

    // Quick Preset Chips (Pickup & Dropoff)
    const presetChips = document.querySelectorAll('.preset-chip');
    presetChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const target = chip.getAttribute('data-target');
        const val = chip.getAttribute('data-val') || '';
        const lat = parseFloat(chip.getAttribute('data-lat')) || SERVICE_AREA.center.lat;
        const lng = parseFloat(chip.getAttribute('data-lng')) || SERVICE_AREA.center.lng;

        if (target === 'pickup') {
          setPickupLocation(val, lat, lng);
          if (pickupClearBtn) pickupClearBtn.classList.remove('is-hidden');
        } else if (target === 'dropoff') {
          bookingState.actualOneWayDistanceKm = null;
          bookingState.upfrontPrice = null;
          bookingState.estimatedDistanceKm = null;
          bookingState.dropoff = { address: val, lat, lng };
          if (dropoffAddressInput) {
            dropoffAddressInput.value = val;
            if (dropoffClearBtn) dropoffClearBtn.classList.remove('is-hidden');
          }
          updateBookingMap();
        }
      });
    });

    // Helper to geocode manual text inputs on blur/change
    function tryGeocodeField(field) {
      if (!global.google || !global.google.maps || !global.google.maps.Geocoder) return;
      const geocoder = new google.maps.Geocoder();
      if (field === 'pickup') {
        const addr = (pickupAddressInput ? pickupAddressInput.value : '').trim();
        if (!addr || (bookingState.pickup.lat && bookingState.pickup.lng)) return;
        geocoder.geocode({ address: addr, componentRestrictions: { country: 'za' } }, (results, status) => {
          if (status === 'OK' && results && results[0] && results[0].geometry) {
            const loc = results[0].geometry.location;
            setPickupLocation(results[0].formatted_address || addr, loc.lat(), loc.lng());
          }
        });
      } else if (field === 'dropoff') {
        const addr = (dropoffAddressInput ? dropoffAddressInput.value : '').trim();
        if (!addr || (bookingState.dropoff.lat && bookingState.dropoff.lng)) return;
        geocoder.geocode({ address: addr, componentRestrictions: { country: 'za' } }, (results, status) => {
          if (status === 'OK' && results && results[0] && results[0].geometry) {
            const loc = results[0].geometry.location;
            bookingState.actualOneWayDistanceKm = null;
            bookingState.upfrontPrice = null;
            bookingState.estimatedDistanceKm = null;
            bookingState.dropoff = { address: results[0].formatted_address || addr, lat: loc.lat(), lng: loc.lng() };
            updateBookingMap();
          }
        });
      }
    }

    // Pickup input manual change & select on focus
    if (pickupAddressInput) {
      pickupAddressInput.addEventListener('input', () => {
        const val = pickupAddressInput.value;
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.pickup.address = val;
        if (pickupClearBtn) pickupClearBtn.classList.toggle('is-hidden', !val.trim());
        bookingState.pickup.lat = null;
        bookingState.pickup.lng = null;
        if (pickupGeofenceBadge) {
          pickupGeofenceBadge.className = 'geofence-badge';
          pickupGeofenceBadge.textContent = '📍 Enter Pickup Location';
        }
        if (pickupErrorEl) pickupErrorEl.classList.add('is-hidden');
        updateBookingMap();
      });

      pickupAddressInput.addEventListener('change', () => tryGeocodeField('pickup'));

      // If user focuses pickup while GPS text is present, select all for instant 1-key replacement
      pickupAddressInput.addEventListener('focus', () => {
        if (pickupAddressInput.value && pickupAddressInput.value.startsWith('Current GPS Location')) {
          pickupAddressInput.select();
        }
      });
    }

    // Dropoff input manual change
    if (dropoffAddressInput) {
      dropoffAddressInput.addEventListener('input', () => {
        const val = dropoffAddressInput.value;
        bookingState.actualOneWayDistanceKm = null;
        bookingState.upfrontPrice = null;
        bookingState.estimatedDistanceKm = null;
        bookingState.dropoff.address = val;
        if (dropoffClearBtn) dropoffClearBtn.classList.toggle('is-hidden', !val.trim());
        bookingState.dropoff.lat = null;
        bookingState.dropoff.lng = null;
        updateBookingMap();
      });

      dropoffAddressInput.addEventListener('change', () => tryGeocodeField('dropoff'));
    }

    // Note counter & dismiss on enter
    if (bookingNoteInput) {
      bookingNoteInput.addEventListener('input', () => {
        if (bookingNoteCount) bookingNoteCount.textContent = `${bookingNoteInput.value.length}/64`;
      });
      bookingNoteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          bookingNoteInput.blur();
        }
      });
    }

    // Active Trip Modal
    if (viewActiveBookingBtn) viewActiveBookingBtn.addEventListener('click', openActiveTripModal);
    if (activeTripModalClose) activeTripModalClose.addEventListener('click', closeActiveTripModal);
    if (cancelPendingBtn) cancelPendingBtn.addEventListener('click', handleCancelPending);
    if (completedDoneBtn) completedDoneBtn.addEventListener('click', handleCompletedDone);
    if (cancelledDismissBtn) cancelledDismissBtn.addEventListener('click', closeActiveTripModal);

    // App Test Modal
    if (appTestModalClose) appTestModalClose.addEventListener('click', closeAppTestModal);
    if (appTestModalCancel) appTestModalCancel.addEventListener('click', closeAppTestModal);
    if (appTestModal) {
      appTestModal.addEventListener('click', (e) => {
        if (e.target === appTestModal) closeAppTestModal();
      });
    }

    // Confirm Booking Modal
    if (confirmBookingModalClose) confirmBookingModalClose.addEventListener('click', closeConfirmBookingModal);
    if (confirmBookingBackBtn) confirmBookingBackBtn.addEventListener('click', closeConfirmBookingModal);
    if (confirmBookingSubmitBtn) confirmBookingSubmitBtn.addEventListener('click', handleConfirmBookingSubmit);
    if (confirmBookingModal) {
      confirmBookingModal.addEventListener('click', (e) => {
        if (e.target === confirmBookingModal) closeConfirmBookingModal();
      });
    }

    // Rating star selectors
    ratingStarBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const starVal = parseInt(btn.getAttribute('data-star') || '5', 10);
        selectedStars = starVal;
        ratingStarBtns.forEach((b) => {
          const val = parseInt(b.getAttribute('data-star') || '0', 10);
          b.classList.toggle('is-starred', val <= starVal);
        });
      });
    });
  }

  /** Main App Boot */
  function boot() {
    initListeners();
    initPricingRatesListener();
    initAppConfigListener();

    AccountAccess.observe(async (authUser) => {
      if (!authUser) {
        renderUserState(null, null);
        return;
      }

      try {
        const userDocRef = db.collection(FS.users).doc(authUser.uid);
        const doc = await userDocRef.get({ source: 'server' });
        if (AccountAccess.currentUser?.uid !== authUser.uid) return;
        if (!doc.exists) throw new Error(AccountAccessCore.messages['auth/account-unverified']);
        const data = doc.data();

        renderUserState(authUser, data);
      } catch (err) {
        console.error('Failed to load user profile doc:', err);
        renderUserState(null, null);
      }
    });
  }

  // Refresh only existing map overlays; changing theme never requests a new route.
  global.addEventListener('themeChanged', () => {
    const color = global.DigilaynTheme.getColor('info');
    if (bookingPoortjieCircle) bookingPoortjieCircle.setOptions({ strokeColor: color, fillColor: color });
    if (bookingDirectionsRenderer) bookingDirectionsRenderer.setOptions({
      polylineOptions: { strokeColor: color, strokeWeight: 5, strokeOpacity: 0.9 }
    });
    if (trackingDirectionsRenderer) trackingDirectionsRenderer.setOptions({
      polylineOptions: { strokeColor: color, strokeWeight: 5, strokeOpacity: 0.9 }
    });
  });

  // Expose API
  global.LaynRiderBooking = {
    getCurrentUser: () => currentUser,
    getUserProfile: () => userProfile,
    isProfileComplete: () => isProfileComplete,
    openBookingForm,
    openConfirmBookingModal,
    closeConfirmBookingModal,
    openAppTestModal,
    closeAppTestModal,
    openActiveTripModal,
    navigateToProfile,
    signOut: handleSignOut
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
