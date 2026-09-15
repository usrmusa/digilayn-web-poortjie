/* Shared image compression and upload boundary for all Poortjie web forms. */
class ImageUpload {
  static maxBytes = 1000000;

  static assertSize(blob) {
    if (!blob || blob.size <= 0 || blob.size >= ImageUpload.maxBytes) {
      throw new Error('Could not compress this picture to under 1 MB. Please choose another image.');
    }
  }

  static async compressCanvas(source, onProgress = () => {}) {
    if (!source || !source.width || !source.height) throw new Error('Could not read this image.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(source.width, source.height));
    canvas.width = Math.max(1, Math.floor(source.width * scale));
    canvas.height = Math.max(1, Math.floor(source.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image compression is unavailable in this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    let attempt = 0;
    let quality = 0.9;
    while (true) {
      attempt += 1;
      onProgress(`Compressing to under 1 MB — attempt ${attempt}…`);
      // Allow the browser to paint progress before each encoding pass.
      await new Promise(resolve => setTimeout(resolve, 0));
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || blob.size === 0) throw new Error('Could not process this image. Please choose another picture.');
      onProgress(`Compressing to under 1 MB — attempt ${attempt}: ${(blob.size / 1000000).toFixed(2)} MB`);
      if (blob.size < ImageUpload.maxBytes) {
        ImageUpload.assertSize(blob);
        onProgress(`Compressed to ${(blob.size / 1000).toFixed(1)} KB — under 1 MB. Preparing upload…`);
        return blob;
      }
      if (quality > 0.2) {
        quality = Math.max(0.2, quality - 0.15);
        continue;
      }
      if (canvas.width === 1 && canvas.height === 1) {
        throw new Error('Could not compress this picture to under 1 MB. Please choose another image.');
      }
      const smaller = document.createElement('canvas');
      smaller.width = Math.max(1, Math.floor(canvas.width * 0.75));
      smaller.height = Math.max(1, Math.floor(canvas.height * 0.75));
      const smallerContext = smaller.getContext('2d');
      if (!smallerContext) throw new Error('Image compression is unavailable in this browser.');
      smallerContext.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      canvas.width = smaller.width;
      canvas.height = smaller.height;
      context.drawImage(smaller, 0, 0);
      quality = 0.9;
    }
  }

  static async compressFile(file, onProgress = () => {}, square = false) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    onProgress('Reading picture — we compress all images to under 1 MB…');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Could not read this image. Please choose another picture.'));
        image.src = url;
      });
      if (square) {
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        const cropped = document.createElement('canvas');
        cropped.width = cropped.height = Math.min(size, 1200);
        const context = cropped.getContext('2d');
        if (!context) throw new Error('Image compression is unavailable in this browser.');
        context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2,
          size, size, 0, 0, cropped.width, cropped.height);
        return await ImageUpload.compressCanvas(cropped, onProgress);
      }
      return await ImageUpload.compressCanvas(image, onProgress);
    } finally { URL.revokeObjectURL(url); }
  }

  static async upload(ref, blob, onProgress = () => {}, metadata = {}) {
    ImageUpload.assertSize(blob);
    onProgress('Compressed to under 1 MB. Uploading — 0%');
    const task = ref.put(blob, { ...metadata, contentType: 'image/jpeg' });
    task.on('state_changed', snapshot => {
      const percent = snapshot.totalBytes ? Math.floor(snapshot.bytesTransferred / snapshot.totalBytes * 100) : 0;
      onProgress(`Compressed to under 1 MB. Uploading — ${percent}%`);
    });
    return await task;
  }
}
if (typeof module !== 'undefined') module.exports = ImageUpload;
