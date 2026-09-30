export interface UploadEntry {
  file: File;
  relativePath: string;
}

export interface UploadSelection {
  files: UploadEntry[];
  directories: string[];
}

export function selectionFromFiles(files: FileList | File[]): UploadSelection {
  const entries = Array.from(files, (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
  return {
    files: entries,
    directories: entries.flatMap(({ relativePath }) => parentDirectories(relativePath)),
  };
}

function parentDirectories(relativePath: string): string[] {
  const parts = relativePath.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(all);
      else {
        all.push(...batch);
        next();
      }
    }, reject);
    next();
  });
}

async function collectEntry(entry: FileSystemEntry, parent: string, selection: UploadSelection): Promise<void> {
  const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) {
    selection.files.push({ file: await readFile(entry as FileSystemFileEntry), relativePath });
    return;
  }
  if (entry.isDirectory) {
    selection.directories.push(relativePath);
    for (const child of await readDirectory(entry as FileSystemDirectoryEntry)) {
      await collectEntry(child, relativePath, selection);
    }
  }
}

export async function selectionFromDrop(dataTransfer: DataTransfer): Promise<UploadSelection> {
  const entries = Array.from(dataTransfer.items, (item) => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (entries.length === 0) return selectionFromFiles(dataTransfer.files);

  const selection: UploadSelection = { files: [], directories: [] };
  for (const entry of entries) await collectEntry(entry, '', selection);
  return selection;
}

export function validUploadPath(relativePath: string): boolean {
  return relativePath.length > 0 && relativePath.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !/[\\\u0000-\u001f]/.test(part),
  );
}
