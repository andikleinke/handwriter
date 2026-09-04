/**
 * Saving a finished take: a regular download through an anchor click.
 *
 * Browsers allow a page a couple of downloads without a user gesture, then
 * ask once whether to allow "multiple automatic downloads" for the site;
 * allowing that keeps takes arriving by themselves. The blob URL is revoked
 * later, not at once - revoking synchronously can abort the download.
 */
export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
