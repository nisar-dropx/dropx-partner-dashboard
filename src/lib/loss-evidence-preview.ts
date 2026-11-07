/** Keep evidence with its original host; never send private links to a third-party viewer. */
export function lossEvidencePreview(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const fileName = decodeURIComponent(url.pathname.split('/').pop() || '');
    const resourceKey = url.searchParams.get('resourcekey');
    if (url.hostname === 'drive.google.com') {
      const folder = url.pathname.match(/\/folders\/([\w-]+)/)?.[1];
      const id = folder || url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] || url.searchParams.get('id');
      if (id && /^[\w-]+$/.test(id)) {
        const preview = new URL(folder ? 'https://drive.google.com/embeddedfolderview' : `https://drive.google.com/file/d/${id}/preview`);
        if (folder) { preview.searchParams.set('id', id); preview.hash = 'list'; }
        if (resourceKey) preview.searchParams.set('resourcekey', resourceKey);
        return { href: url.href, fileName, embedUrl: preview.href, video: false };
      }
    }
    if (url.hostname === 'docs.google.com') {
      const doc = url.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
      if (doc) return { href: url.href, fileName, embedUrl: `https://docs.google.com/${doc[1]}/d/${doc[2]}/preview`, video: false };
    }
    return { href: url.href, fileName, embedUrl: undefined, video: /\.(mp4|webm|ogg)$/i.test(fileName) };
  } catch { return null; }
}
