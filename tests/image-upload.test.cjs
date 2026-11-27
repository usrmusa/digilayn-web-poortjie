const { test } = require('node:test');
const assert = require('node:assert/strict');
const ImageUpload = require('../scripts/image-upload.js');

// Canvas is the encoder boundary; exercise the production compression loop against
// controlled encoder results, including persistent oversized and failed output.
function encoder(size) {
  let calls = 0;
  const dimensions = [];
  global.document = { createElement() {
    return { width: 0, height: 0,
      getContext: () => ({ fillRect() {}, drawImage() {} }),
      toBlob(callback, type, quality) {
        calls++;
        dimensions.push([this.width, this.height, quality]);
        const bytes = size(calls, this.width, this.height);
        callback(bytes === null ? null : new Blob([new Uint8Array(bytes)], { type }));
      }
    };
  } };
  return { dimensions, calls: () => calls };
}

test('keeps compressing at exactly 1 MB, returns only strictly smaller output', async () => {
  const fake = encoder(call => call < 3 ? 1000000 : 999999);
  const progress = [];
  const blob = await ImageUpload.compressCanvas({ width: 800, height: 800 }, value => progress.push(value));
  assert.equal(blob.size, 999999);
  assert.equal(fake.calls(), 3);
  assert.ok(progress.some(value => value.includes('attempt 3')));
});
test('reduces dimensions after quality attempts are exhausted', async () => {
  const fake = encoder((call, width) => width > 600 ? 1000100 : 800000);
  const blob = await ImageUpload.compressCanvas({ width: 800, height: 800 });
  assert.equal(blob.size, 800000);
  assert.ok(fake.dimensions.some(([width]) => width === 600));
});
test('failed encodes and irreducible oversized images fail closed', async () => {
  encoder(() => null);
  await assert.rejects(ImageUpload.compressCanvas({ width: 1, height: 1 }), /Could not process/);
  encoder(() => 1000000);
  await assert.rejects(ImageUpload.compressCanvas({ width: 1, height: 1 }), /under 1 MB/);
});
test('upload rejects empty and oversized files before contacting storage', async () => {
  const ref = { put() { throw new Error('Storage must not be called'); } };
  for (const size of [0, 1000000, 1100000]) {
    await assert.rejects(ImageUpload.upload(ref, new Blob([new Uint8Array(size)])), /under 1 MB/);
  }
});
test('valid upload sends JPEG metadata and reports actual transferred percentage', async () => {
  const progress = [];
  const ref = { put(blob, metadata) {
    assert.equal(blob.size, 500);
    assert.equal(metadata.contentType, 'image/jpeg');
    const task = Promise.resolve({ complete: true });
    task.on = (event, callback) => callback({ totalBytes: 500, bytesTransferred: 250 });
    return task;
  } };
  const result = await ImageUpload.upload(ref, new Blob([new Uint8Array(500)]), value => progress.push(value));
  assert.equal(result.complete, true);
  assert.ok(progress.some(value => value.includes('50%')));
});
