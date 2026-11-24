/**
 * Save / open helpers. In Chromium (Edge / Chrome, including the StemForge app window) these
 * use the native Windows "Save As" / "Open" / folder dialogs via the File System Access API;
 * elsewhere they fall back to a regular download / file input.
 */

export interface FilePickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface WritableLike {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  name: string;
  kind?: 'file';
  createWritable(): Promise<WritableLike>;
  getFile?(): Promise<File>;
}

export interface DirectoryHandleLike {
  name: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
}

interface FsWindow {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: FilePickerType[]; id?: string }) => Promise<FileHandleLike>;
  showOpenFilePicker?: (opts: { types?: FilePickerType[]; multiple?: boolean; id?: string }) => Promise<Array<FileHandleLike & { getFile(): Promise<File> }>>;
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
}

const fsWindow = (): FsWindow => window as unknown as FsWindow;

export const supportsNativeSave = (): boolean => typeof fsWindow().showSaveFilePicker === 'function';
export const supportsDirectoryPicker = (): boolean => typeof fsWindow().showDirectoryPicker === 'function';

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export interface SaveResult {
  fileName: string;
  method: 'dialog' | 'download';
  handle?: FileHandleLike;
}

/** Asks where to save (native dialog) and writes the file. Returns null if the user cancels. */
export async function saveFileAs(
  blob: Blob,
  suggestedName: string,
  types?: FilePickerType[],
  pickerId?: string
): Promise<SaveResult | null> {
  const w = fsWindow();
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types, id: pickerId });
      await writeToHandle(handle, blob);
      return { fileName: handle.name, method: 'dialog', handle };
    } catch (err) {
      if (isAbort(err)) return null;
      // fall back to a download (e.g. picker blocked)
    }
  }
  downloadBlob(blob, suggestedName);
  return { fileName: suggestedName, method: 'download' };
}

export async function writeToHandle(handle: FileHandleLike, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** Asks for a folder (native dialog). Returns null if unsupported or cancelled. */
export async function pickDirectory(pickerId?: string): Promise<DirectoryHandleLike | null> {
  const w = fsWindow();
  if (!w.showDirectoryPicker) return null;
  try {
    return await w.showDirectoryPicker({ id: pickerId, mode: 'readwrite' });
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

export async function writeFileInDirectory(dir: DirectoryHandleLike, fileName: string, blob: Blob): Promise<void> {
  const handle = await dir.getFileHandle(fileName, { create: true });
  await writeToHandle(handle, blob);
}

/** Opens a file (native dialog or hidden input). */
export async function openFile(types: FilePickerType[], acceptAttr: string, pickerId?: string): Promise<File | null> {
  const w = fsWindow();
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types, multiple: false, id: pickerId });
      return handle ? await handle.getFile() : null;
    } catch (err) {
      if (isAbort(err)) return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptAttr;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export const SFG_TYPES: FilePickerType[] = [
  { description: 'StemForge project', accept: { 'application/x-stemforge-project': ['.sfg'] } },
];

export function sanitizeFileName(name: string, fallback = 'stemforge'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().replace(/[. ]+$/, '');
  return cleaned.slice(0, 150) || fallback;
}
