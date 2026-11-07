import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';

export type ImagePasteOptions = {
  onImages: (files: { name: string; bytes: Uint8Array }[]) => Promise<{ path: string }[]>;
  /** Read at event time, so an asynchronous import cannot insert into another tab. */
  getTexFilePath?: () => string | null;
  /** Disable event handling when the host has no import callback or is not editing TeX. */
  enabled?: () => boolean;
};
export function includeGraphicsSnippet(relativePath: string, texFileDir: string): string {
  const target = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const source = texFileDir.replaceAll('\\', '/').split('/').filter(Boolean);
  while (source.length && target.length && source[0] === target[0]) { source.shift(); target.shift(); }
  const path = [...source.map(() => '..'), ...target].join('/').replace(/\.(png|jpe?g|pdf|eps)$/i, '');
  const slug = (relativePath.replaceAll('\\', '/').split('/').at(-1) ?? 'image').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'image';
  return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${path}}\n  \\caption{}\n  \\label{fig:${slug}}\n\\end{figure}\n`;
}
export function pastedImageName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `pasted-image-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}
export function isEditorAsset(file: Pick<File, 'name' | 'type'>): boolean {
  return /^image\//i.test(file.type) || /\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i.test(file.name);
}
export function imagePasteExtension(options: ImagePasteOptions): Extension {
  const handle = (event: ClipboardEvent | DragEvent, view: EditorView, paste: boolean): boolean => {
    if (view.state.facet(EditorState.readOnly) || options.enabled?.() === false) return false;
    const transfer = paste ? (event as ClipboardEvent).clipboardData : (event as DragEvent).dataTransfer;
    const files = Array.from(transfer?.files ?? []).filter(file => paste ? /^image\//i.test(file.type) : isEditorAsset(file));
    if (!files.length) return false;
    event.preventDefault();
    const texPath = options.getTexFilePath?.();
    const texDir = texPath?.split('/').slice(0, -1).join('/') ?? '';
    void Promise.all(files.map(async (file, index) => {
      let blob: Blob = file;
      if (paste && file.type.toLowerCase() !== 'image/png') {
        // A clipboard JPEG must not be saved as mislabeled PNG bytes.
        const bitmap = await createImageBitmap(file);
        try {
          const canvas = document.createElement('canvas');canvas.width = bitmap.width;canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('PNG clipboard conversion is unavailable');
          context.drawImage(bitmap, 0, 0);
          const { promise, resolve, reject } = Promise.withResolvers<Blob>();
          canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG clipboard conversion failed')), 'image/png');
          blob = await promise;
        } finally { bitmap.close(); }
      }
      return { name: paste ? pastedImageName().replace('.png', `${index ? `-${index}` : ''}.png`) : file.name, bytes: new Uint8Array(await blob.arrayBuffer()) };
    }))
      .then(options.onImages)
      .then(imported => {
        if (!imported.length || !view.dom.isConnected || view.state.facet(EditorState.readOnly) || options.getTexFilePath?.() !== texPath) return;
        const snippet = imported.map(file => includeGraphicsSnippet(file.path, texDir)).join('\n');
        view.dispatch({ ...view.state.replaceSelection(snippet), annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')], scrollIntoView: true });
      }).catch(() => { /* The importing callback reports native failures to the workspace UI. */ });
    return true;
  };
  return EditorView.domEventHandlers({ paste: (event, view) => handle(event, view, true), drop: (event, view) => handle(event, view, false) });
}
