
document.addEventListener('DOMContentLoaded', () => {
    const loaderId = 'global-loader';
    if (document.getElementById(loaderId)) {
        return;
    }

    const loaderHTML = `
        <div id="${loaderId}" class="fixed inset-0 bg-digilayn-surface dark:bg-digilayn-surface bg-opacity-90 dark:bg-opacity-90 flex flex-col justify-center items-center z-50">
            <div class="loader ease-linear rounded-full border-8 border-t-8 border-digilayn-outline-variant dark:border-digilayn-outline-variant h-24 w-24 mb-4"></div>
            <p class="text-lg opacity-70">Please wait...</p>
        </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
        .loader {
            border-top-color: var(--digilayn-primary); /* green-500 */
            animation: spinner 1.5s linear infinite;
        }

        @keyframes spinner {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    `;

    document.head.appendChild(style);
    document.body.insertAdjacentHTML('beforeend', loaderHTML);
});

function showLoader() {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.display = 'flex';
    }
}

function hideLoader() {
    const loader = document.getElementById('global-loader');
    if (loader) {
        loader.style.display = 'none';
    }
}
