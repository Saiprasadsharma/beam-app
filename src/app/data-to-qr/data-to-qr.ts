import { Component, HostListener, OnDestroy, PLATFORM_ID, computed, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as QRCode from 'qrcode';

interface QrChunk {
  index: number;
  text: string;
  dataUrl: string;
}

type PayloadMode = 'z' | 'r'; // z = deflate+base64, r = raw text

interface ScannedCode {
  id: number;
  batchId: string;
  chunkIndex: number;
  chunkTotal: number;
  mode: PayloadMode;
  crc: string;
  payload: string;
}

type Tab = 'generate' | 'scan';
type DisplayMode = 'all' | 'loop';
type VerifyState = 'idle' | 'ok' | 'bad';

// Kept small enough that each QR code's modules stay large enough to scan
// reliably with a webcam (dense high-version codes from larger chunks were
// flaky to decode, especially off a phone screen).
// Characters of data per QR code. Fewer characters = a simpler, bigger-module code that
// low-quality webcams can read more easily, at the cost of more codes.
const DENSITY_OPTIONS = [
  { size: 150, label: 'Easiest to scan (150 chars)' },
  { size: 200, label: 'Easy (200 chars)' },
  { size: 250, label: 'Balanced (250 chars)' },
  { size: 300, label: 'Dense (300 chars)' },
];
const DEFAULT_CHUNK_SIZE = 250;
const MAX_PARTS = 999; // header stores index/total in 3 digits
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// Marks a file entry inside the payload (see packFiles).
const FILE_MARK = '\u0001QRM';
const DEFAULT_DOWNLOAD_NAME = 'combined-text';
const ROTATION_TICK_MS = 100; // rotation clock resolution; fastest per-code time is 0.2s

// Header: magic(4) batchId(6) index(3) total(3) mode(1) crc32-hex(8) = 25 chars,
// followed by the raw chunk payload. Nothing is persisted anywhere; the whole
// transfer lives in memory only.
const QR_MAGIC = 'QRB2';
const QR_HEADER_LENGTH = 25;

function makeBatchId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

function encodeChunkHeader(batchId: string, index: number, total: number, mode: PayloadMode, crc: string): string {
  return `${QR_MAGIC}${batchId}${String(index).padStart(3, '0')}${String(total).padStart(3, '0')}${mode}${crc}`;
}

interface ParsedChunk {
  batchId: string;
  index: number;
  total: number;
  mode: PayloadMode;
  crc: string;
  payload: string;
}

function parseChunkHeader(decodedText: string): ParsedChunk | null {
  if (decodedText.length < QR_HEADER_LENGTH || decodedText.slice(0, 4) !== QR_MAGIC) {
    return null;
  }
  const batchId = decodedText.slice(4, 10);
  const index = Number(decodedText.slice(10, 13));
  const total = Number(decodedText.slice(13, 16));
  const mode = decodedText.slice(16, 17);
  const crc = decodedText.slice(17, 25);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total ||
    (mode !== 'z' && mode !== 'r') ||
    !/^[0-9a-f]{8}$/.test(crc)
  ) {
    return null;
  }
  return { batchId, index, total, mode, crc, payload: decodedText.slice(QR_HEADER_LENGTH) };
}

// ---- CRC32 (integrity check on the reassembled payload) ----
let crcTable: Uint32Array | null = null;
function crc32Hex(text: string): string {
  return crc32(new TextEncoder().encode(text)).toString(16).padStart(8, '0');
}

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- Minimal ZIP writer (store only, UTF-8 names) so several files download as one ----
function buildZip(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const body: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const size = file.data.length;
    const crc = crc32(file.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 file names
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);

    body.push(local, file.data);
    central.push(entry);
    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...body, ...central, end] as BlobPart[], { type: 'application/zip' });
}

/** Strips path/invalid characters so a name received over QR can't escape the download folder. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return cleaned || 'file';
}

// ---- Compression (deflate-raw + base64) ----
async function deflateToBase64(text: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  } catch {
    return null;
  }
}

async function inflateFromBase64(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// ---- Part-number helpers ----
function toRanges(nums: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) {
      j++;
    }
    parts.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** Parses "12-15, 40, 77" into a set of part numbers. */
function parsePartFilter(text: string): Set<number> {
  const result = new Set<number>();
  for (const token of text.split(/[,\s]+/)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(token.trim());
    if (!m) {
      continue;
    }
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    for (let n = Math.min(start, end); n <= Math.max(start, end) && n <= MAX_PARTS; n++) {
      result.add(n);
    }
  }
  return result;
}

interface TransferFile {
  name: string;
  text: string;
}

/** Packs files as repeated: MARK + 3-digit name length + name + 8-digit content length + content. */
function packFiles(files: TransferFile[]): string {
  return files
    .map((f) => {
      const name = f.name.slice(0, 200);
      return `${FILE_MARK}${String(name.length).padStart(3, '0')}${name}${String(f.text.length).padStart(8, '0')}${f.text}`;
    })
    .join('');
}

function unpackFiles(text: string): TransferFile[] | null {
  const files: TransferFile[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (!text.startsWith(FILE_MARK, pos)) {
      return null;
    }
    pos += FILE_MARK.length;
    const nameLength = Number(text.slice(pos, pos + 3));
    pos += 3;
    const name = text.slice(pos, pos + nameLength);
    pos += nameLength;
    const contentLength = Number(text.slice(pos, pos + 8));
    pos += 8;
    if (!Number.isInteger(nameLength) || !Number.isInteger(contentLength) || pos + contentLength > text.length) {
      return null;
    }
    files.push({ name, text: text.slice(pos, pos + contentLength) });
    pos += contentLength;
  }
  return files.length > 0 ? files : null;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

@Component({
  selector: 'app-data-to-qr',
  imports: [CommonModule, FormsModule],
  templateUrl: './data-to-qr.html',
  styleUrl: './data-to-qr.scss',
})
export class DataToQr implements OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // ---- Generator state ----
  protected readonly inputText = signal('');
  protected readonly qrChunks = signal<QrChunk[]>([]);
  protected readonly isGenerating = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly generatedInfo = signal('');

  protected readonly files = signal<TransferFile[]>([]);

  protected readonly charCount = computed(() =>
    this.files().length > 0 ? this.files().reduce((sum, f) => sum + f.text.length, 0) : this.inputText().length,
  );
  protected readonly densityOptions = DENSITY_OPTIONS;
  protected readonly chunkSize = signal(DEFAULT_CHUNK_SIZE);
  protected readonly chunkCount = computed(() => Math.ceil(this.charCount() / this.chunkSize()));

  protected onDensityChange(event: Event): void {
    this.chunkSize.set(Number((event.target as HTMLSelectElement).value) || DEFAULT_CHUNK_SIZE);
  }

  // ---- Auto-rotate display state ----
  protected readonly displayMode = signal<DisplayMode>('all');
  protected readonly rotationIntervalSeconds = signal(5);
  protected readonly rotationIndex = signal(0);
  protected readonly rotationMsLeft = signal(5000);
  protected readonly rotationCycle = signal(1);
  protected readonly rotationPaused = signal(false);
  protected readonly partsFilter = signal('');
  protected readonly isFullscreen = signal(false);
  private rotationTimerId: ReturnType<typeof setInterval> | null = null;

  /** Chunks included in the rotation: all of them, or only those listed in the filter. */
  protected readonly rotationChunks = computed(() => {
    const chunks = this.qrChunks();
    const wanted = parsePartFilter(this.partsFilter());
    return wanted.size === 0 ? chunks : chunks.filter((c) => wanted.has(c.index));
  });
  protected readonly activeRotationChunk = computed(() => this.rotationChunks()[this.rotationIndex()] ?? null);

  // ---- Tab state ----
  protected readonly activeTab = signal<Tab>('generate');

  // ---- Scanner state ----
  private html5QrCode: import('html5-qrcode').Html5Qrcode | null = null;
  private nextScanId = 1;
  private lastScannedIndex: number | null = null;
  private ignoredBatchId: string | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;
  private copiedToClipboard = false;
  private decodeToken = 0;

  protected readonly scannedCodes = signal<ScannedCode[]>([]);
  protected readonly isScanning = signal(false);
  protected readonly isStartingScan = signal(false);
  protected readonly scanError = signal('');
  protected readonly justScannedId = signal<number | null>(null);
  protected readonly duplicateFlash = signal(false);
  protected readonly gapWarning = signal('');
  protected readonly pendingBatch = signal<ParsedChunk | null>(null);
  protected readonly torchSupported = signal(false);
  protected readonly torchOn = signal(false);

  protected readonly combinedText = signal('');
  protected readonly receivedFiles = signal<TransferFile[]>([]);
  protected readonly verifyState = signal<VerifyState>('idle');

  protected readonly scanProgress = computed(() => {
    const codes = this.scannedCodes();
    if (codes.length === 0) {
      return { scannedCount: 0, total: 0, missingIndices: [] as number[], complete: false };
    }
    const total = codes[0].chunkTotal;
    const present = new Set(codes.map((c) => c.chunkIndex));
    const missingIndices: number[] = [];
    for (let i = 1; i <= total; i++) {
      if (!present.has(i)) {
        missingIndices.push(i);
      }
    }
    return {
      scannedCount: codes.length,
      total,
      missingIndices,
      complete: missingIndices.length === 0,
    };
  });

  protected readonly missingRanges = computed(() => toRanges(this.scanProgress().missingIndices));
  protected readonly progressPercent = computed(() => {
    const p = this.scanProgress();
    return p.total === 0 ? 0 : Math.round((p.scannedCount / p.total) * 100);
  });

  protected readonly partMap = computed(() => {
    const total = this.scanProgress().total;
    const present = new Set(this.scannedCodes().map((c) => c.chunkIndex));
    return Array.from({ length: total }, (_, i) => ({ index: i + 1, scanned: present.has(i + 1) }));
  });

  private readonly assembled = computed(() => {
    if (!this.scanProgress().complete) {
      return null;
    }
    const sorted = [...this.scannedCodes()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    return { payload: sorted.map((c) => c.payload).join(''), mode: sorted[0].mode, crc: sorted[0].crc };
  });

  protected readonly combinedCharCount = computed(() => this.combinedText().length);

  constructor() {
    effect(() => {
      const assembled = this.assembled();
      untracked(() => void this.decode(assembled));
    });
  }

  ngOnDestroy(): void {
    void this.stopScan();
    this.clearRotationTimer();
    this.scannedCodes.set([]);
    this.combinedText.set('');
    this.receivedFiles.set([]);
  }

  // Warn before a refresh/close throws away a half-finished scan (nothing is saved to disk).
  @HostListener('window:beforeunload', ['$event'])
  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.scannedCodes().length > 0 && !this.scanProgress().complete) {
      event.preventDefault();
    }
  }

  @HostListener('document:fullscreenchange')
  protected onFullscreenChange(): void {
    this.isFullscreen.set(!!document.fullscreenElement);
  }

  // ---- Tab switching ----
  protected setTab(tab: Tab): void {
    if (this.activeTab() === tab) {
      return;
    }
    if (this.activeTab() === 'scan' && tab !== 'scan') {
      void this.stopScan();
    }
    if (this.activeTab() === 'generate' && tab !== 'generate' && this.displayMode() === 'loop') {
      this.clearRotationTimer();
      this.displayMode.set('all');
    }
    this.activeTab.set(tab);
  }

  // ---- Auto-rotate display methods ----
  protected setDisplayMode(mode: DisplayMode): void {
    if (this.displayMode() === mode) {
      return;
    }
    if (mode === 'loop') {
      this.rotationIndex.set(0);
      this.rotationCycle.set(1);
      this.rotationPaused.set(false);
      this.rotationMsLeft.set(this.rotationIntervalSeconds() * 1000);
      this.clearRotationTimer();
      this.rotationTimerId = setInterval(() => this.tickRotation(), ROTATION_TICK_MS);
    } else {
      this.clearRotationTimer();
      this.exitFullscreen();
    }
    this.displayMode.set(mode);
  }

  private tickRotation(): void {
    if (this.rotationPaused()) {
      return;
    }
    const msLeft = this.rotationMsLeft() - ROTATION_TICK_MS;
    if (msLeft > 0) {
      this.rotationMsLeft.set(msLeft);
      return;
    }
    this.stepRotation(1);
  }

  private stepRotation(delta: number): void {
    const total = this.rotationChunks().length;
    if (total === 0) {
      return;
    }
    const raw = this.rotationIndex() + delta;
    const next = ((raw % total) + total) % total;
    if (delta > 0 && raw >= total) {
      this.rotationCycle.set(this.rotationCycle() + 1);
    }
    this.rotationIndex.set(next);
    this.rotationMsLeft.set(this.rotationIntervalSeconds() * 1000);
  }

  protected nextPart(): void {
    this.stepRotation(1);
  }

  protected prevPart(): void {
    this.stepRotation(-1);
  }

  protected togglePause(): void {
    this.rotationPaused.set(!this.rotationPaused());
    this.rotationMsLeft.set(this.rotationIntervalSeconds() * 1000);
  }

  protected onJumpInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const position = this.rotationChunks().findIndex((c) => c.index === value);
    if (position >= 0) {
      this.rotationIndex.set(position);
      this.rotationMsLeft.set(this.rotationIntervalSeconds() * 1000);
    }
  }

  protected onFilterInput(event: Event): void {
    this.partsFilter.set((event.target as HTMLInputElement).value);
    this.rotationIndex.set(0);
    this.rotationMsLeft.set(this.rotationIntervalSeconds() * 1000);
  }

  protected clearFilter(): void {
    this.partsFilter.set('');
    this.rotationIndex.set(0);
  }

  protected async toggleFullscreen(): Promise<void> {
    if (!this.isBrowser) {
      return;
    }
    if (document.fullscreenElement) {
      await this.exitFullscreen();
      return;
    }
    try {
      await document.querySelector('.qr__rotate-view')?.requestFullscreen();
    } catch {
      // Fullscreen is optional; ignore if the browser refuses.
    }
  }

  private async exitFullscreen(): Promise<void> {
    if (this.isBrowser && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Already left fullscreen.
      }
    }
  }

  private clearRotationTimer(): void {
    if (this.rotationTimerId !== null) {
      clearInterval(this.rotationTimerId);
      this.rotationTimerId = null;
    }
  }

  protected onIntervalInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = Math.min(15, Math.max(0.2, Math.round((Number(target.value) || 5) * 10) / 10));
    this.rotationIntervalSeconds.set(value);
    if (this.displayMode() === 'loop') {
      this.rotationMsLeft.set(value * 1000);
    }
  }

  // ---- Generator methods ----
  protected onInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.inputText.set(target.value);
  }

  protected async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    await this.loadFiles(picked);
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    void this.loadFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  protected removeFile(name: string): void {
    this.files.set(this.files().filter((f) => f.name !== name));
    this.qrChunks.set([]);
    this.generatedInfo.set('');
  }

  protected clearFiles(): void {
    this.files.set([]);
    this.qrChunks.set([]);
    this.generatedInfo.set('');
  }

  private async loadFiles(picked: File[]): Promise<void> {
    if (picked.length === 0) {
      return;
    }
    this.errorMessage.set('');
    const problems: string[] = [];
    let list = this.files();

    for (const file of picked) {
      if (file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name}: too large (${Math.round(file.size / 1024)} KB, limit ${MAX_FILE_BYTES / 1024 / 1024} MB)`);
        continue;
      }
      try {
        const text = await file.text();
        if (text.includes('\u0000')) {
          problems.push(`${file.name}: looks like a binary file`);
          continue;
        }
        // Same name replaces the earlier copy.
        list = [...list.filter((f) => f.name !== file.name), { name: file.name, text }];
      } catch {
        problems.push(`${file.name}: could not be read`);
      }
    }

    this.files.set(list);
    this.qrChunks.set([]);
    this.generatedInfo.set('');
    if (problems.length > 0) {
      this.errorMessage.set(`Skipped — ${problems.join('; ')}.`);
    }
  }

  protected async generate(): Promise<void> {
    const fileList = this.files();
    const text = fileList.length > 0 ? packFiles(fileList) : this.inputText();
    this.errorMessage.set('');
    this.generatedInfo.set('');
    this.clearRotationTimer();
    this.displayMode.set('all');
    this.partsFilter.set('');

    if (!text.trim()) {
      this.errorMessage.set('Please enter some text or upload a file to generate QR codes.');
      this.qrChunks.set([]);
      return;
    }

    this.isGenerating.set(true);

    try {
      // Compress when it actually helps; fall back to raw text otherwise.
      const deflated = await deflateToBase64(text);
      const compressed = deflated !== null && deflated.length < text.length;
      const body = compressed ? deflated : text;
      const mode: PayloadMode = compressed ? 'z' : 'r';
      const crc = crc32Hex(body);

      const chunks = body.match(new RegExp(`.{1,${this.chunkSize()}}`, 'gsu')) ?? [];
      if (chunks.length > MAX_PARTS) {
        this.errorMessage.set(`Text is too large: needs ${chunks.length} QR codes (max ${MAX_PARTS}).`);
        this.qrChunks.set([]);
        return;
      }

      const batchId = makeBatchId();
      const total = chunks.length;
      this.qrChunks.set(
        await Promise.all(
          chunks.map(async (chunk, i): Promise<QrChunk> => {
            const index = i + 1;
            const encoded = encodeChunkHeader(batchId, index, total, mode, crc) + chunk;
            return {
              index,
              text: chunk,
              dataUrl: await QRCode.toDataURL(encoded, { errorCorrectionLevel: 'M', margin: 4, scale: 6 }),
            };
          }),
        ),
      );
      this.generatedInfo.set(
        compressed
          ? `Compressed ${text.length} → ${body.length} chars`
          : 'Sent uncompressed (compression would not make it smaller)',
      );
    } catch {
      this.errorMessage.set('Failed to generate QR codes. Please try again.');
      this.qrChunks.set([]);
    } finally {
      this.isGenerating.set(false);
    }
  }

  protected reset(): void {
    this.inputText.set('');
    this.files.set([]);
    this.qrChunks.set([]);
    this.errorMessage.set('');
    this.generatedInfo.set('');
    this.partsFilter.set('');
    this.clearRotationTimer();
    this.displayMode.set('all');
    void this.exitFullscreen();
  }

  // ---- Scanner methods ----
  protected async startScan(): Promise<void> {
    if (!this.isBrowser || this.isScanning() || this.isStartingScan()) {
      return;
    }

    this.scanError.set('');
    this.isStartingScan.set(true);

    if (!document.getElementById('qr-scanner-viewport')) {
      // Wait a tick for the container to render after a tab switch.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    try {
      const { Html5Qrcode } = await import('html5-qrcode');

      if (!navigator.mediaDevices?.getUserMedia) {
        this.scanError.set('Camera access is not supported in this browser.');
        this.isStartingScan.set(false);
        return;
      }

      const cameraId = this.selectedCameraId();
      this.html5QrCode = new Html5Qrcode('qr-scanner-viewport', {
        verbose: false,
        useBarCodeDetectorIfSupported: true,
      });

      await this.html5QrCode.start(
        cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'environment' },
        {
          fps: 20,
          // A larger box gives the decoder more pixels per module, which matters
          // for dense QR codes — a small box crops away detail.
          // Use ~90% of the frame so a low-res webcam keeps every pixel it can.
          qrbox: (width: number, height: number) => {
            const side = Math.floor(Math.min(width, height) * 0.9);
            return { width: side, height: side };
          },
          videoConstraints: {
            ...(cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'environment' }),
            // Request the highest resolution the camera offers; low-res streams
            // don't have enough detail to resolve the small modules in a dense QR code.
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        (decodedText) => this.onScanSuccess(decodedText),
        () => {
          // Ignore per-frame "no QR found" callbacks; this fires continuously while scanning.
        },
      );

      this.isScanning.set(true);
      this.detectTorch();
      void this.loadCameras(Html5Qrcode);
      void this.acquireWakeLock();
    } catch (err) {
      this.scanError.set(this.describeCameraError(err));
      this.html5QrCode = null;
    } finally {
      this.isStartingScan.set(false);
    }
  }

  protected async stopScan(): Promise<void> {
    const scanner = this.html5QrCode;
    this.html5QrCode = null;

    if (scanner) {
      try {
        await scanner.stop();
        scanner.clear();
      } catch {
        // Scanner was already stopped/torn down; nothing further to clean up.
      }
    }

    this.isScanning.set(false);
    this.torchSupported.set(false);
    this.torchOn.set(false);
    void this.releaseWakeLock();
  }

  // ---- Camera selection (laptops often expose several cameras, e.g. an IR one) ----
  protected readonly cameras = signal<{ id: string; label: string }[]>([]);
  protected readonly selectedCameraId = signal('');

  private async loadCameras(ctor: typeof import('html5-qrcode').Html5Qrcode): Promise<void> {
    try {
      const list = await ctor.getCameras();
      this.cameras.set(list.map((c, i) => ({ id: c.id, label: c.label || `Camera ${i + 1}` })));
    } catch {
      // Picker is optional.
    }
  }

  protected async onCameraChange(event: Event): Promise<void> {
    this.selectedCameraId.set((event.target as HTMLSelectElement).value);
    if (this.isScanning()) {
      await this.stopScan();
      await this.startScan();
    }
  }

  // ---- Torch / wake lock ----
  private detectTorch(): void {
    try {
      const caps = this.html5QrCode?.getRunningTrackCapabilities() as unknown as { torch?: boolean } | undefined;
      this.torchSupported.set(!!caps?.torch);
    } catch {
      this.torchSupported.set(false);
    }
  }

  protected async toggleTorch(): Promise<void> {
    const next = !this.torchOn();
    try {
      await this.html5QrCode?.applyVideoConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      this.torchOn.set(next);
    } catch {
      this.scanError.set('Could not toggle the flashlight on this device.');
    }
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } })
        .wakeLock;
      this.wakeLock = (await wl?.request('screen')) ?? null;
    } catch {
      // Wake lock is a convenience only.
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = null;
    try {
      await lock?.release();
    } catch {
      // Already released.
    }
  }

  // ---- Scan handling ----
  private onScanSuccess(decodedText: string): void {
    const parsed = parseChunkHeader(decodedText);

    if (!parsed) {
      this.scanError.set('Scanned code is not a recognized QR-batch part. Ignored.');
      return;
    }

    const currentBatchId = this.scannedCodes()[0]?.batchId;
    if (currentBatchId && currentBatchId !== parsed.batchId) {
      // Don't silently discard progress: ask first (and don't nag about a batch the user dismissed).
      if (parsed.batchId !== this.ignoredBatchId && this.pendingBatch()?.batchId !== parsed.batchId) {
        this.pendingBatch.set(parsed);
      }
      return;
    }

    this.addChunk(parsed);
  }

  private addChunk(parsed: ParsedChunk): void {
    const codes = this.scannedCodes();
    if (codes.some((c) => c.chunkIndex === parsed.index)) {
      this.flashDuplicate();
      return;
    }

    const entry: ScannedCode = {
      id: this.nextScanId++,
      batchId: parsed.batchId,
      chunkIndex: parsed.index,
      chunkTotal: parsed.total,
      mode: parsed.mode,
      crc: parsed.crc,
      payload: parsed.payload,
    };
    this.scannedCodes.set([...codes, entry]);
    this.scanError.set('');
    this.flashSuccess(entry.id);

    // Warn when the scan jumped over parts that are still missing.
    const previous = this.lastScannedIndex;
    this.lastScannedIndex = parsed.index;
    if (previous !== null && parsed.index > previous + 1) {
      const present = new Set(this.scannedCodes().map((c) => c.chunkIndex));
      const skipped: number[] = [];
      for (let i = previous + 1; i < parsed.index; i++) {
        if (!present.has(i)) {
          skipped.push(i);
        }
      }
      if (skipped.length > 0) {
        this.gapWarning.set(`Skipped part${skipped.length === 1 ? '' : 's'} ${toRanges(skipped)} — still missing`);
        setTimeout(() => this.gapWarning.set(''), 4000);
      }
    }

    if (this.scanProgress().complete) {
      void this.stopScan();
    }
  }

  protected acceptNewBatch(): void {
    const pending = this.pendingBatch();
    if (!pending) {
      return;
    }
    this.scannedCodes.set([]);
    this.lastScannedIndex = null;
    this.ignoredBatchId = null;
    this.pendingBatch.set(null);
    this.addChunk(pending);
  }

  protected keepCurrentBatch(): void {
    this.ignoredBatchId = this.pendingBatch()?.batchId ?? null;
    this.pendingBatch.set(null);
  }

  private async decode(assembled: { payload: string; mode: PayloadMode; crc: string } | null): Promise<void> {
    const token = ++this.decodeToken;
    if (!assembled) {
      this.combinedText.set('');
      this.receivedFiles.set([]);
      this.verifyState.set('idle');
      return;
    }
    if (crc32Hex(assembled.payload) !== assembled.crc) {
      this.combinedText.set('');
      this.receivedFiles.set([]);
      this.verifyState.set('bad');
      return;
    }
    try {
      const text = assembled.mode === 'z' ? await inflateFromBase64(assembled.payload) : assembled.payload;
      if (token === this.decodeToken) {
        if (text.startsWith(FILE_MARK)) {
          const unpacked = unpackFiles(text);
          if (!unpacked) {
            this.combinedText.set('');
            this.receivedFiles.set([]);
            this.verifyState.set('bad');
            return;
          }
          this.combinedText.set('');
          this.receivedFiles.set(unpacked);
        } else {
          this.combinedText.set(text);
          this.receivedFiles.set([]);
        }
        this.verifyState.set('ok');
      }
    } catch {
      if (token === this.decodeToken) {
        this.combinedText.set('');
        this.verifyState.set('bad');
      }
    }
  }

  private flashSuccess(id: number): void {
    this.justScannedId.set(id);
    this.beep();
    if (this.isBrowser && navigator.vibrate) {
      navigator.vibrate(80);
    }
    setTimeout(() => {
      if (this.justScannedId() === id) {
        this.justScannedId.set(null);
      }
    }, 900);
  }

  private flashDuplicate(): void {
    this.duplicateFlash.set(true);
    setTimeout(() => this.duplicateFlash.set(false), 900);
  }

  private beep(): void {
    if (!this.isBrowser) {
      return;
    }
    try {
      const AudioContextCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioContextCtor();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.12);
      oscillator.onended = () => void ctx.close();
    } catch {
      // Audio feedback is a nice-to-have; ignore failures (e.g. autoplay restrictions).
    }
  }

  private describeCameraError(err: unknown): string {
    const name = err instanceof Error ? err.name : '';
    const message = err instanceof Error ? err.message : String(err);

    if (name === 'NotAllowedError' || /permission/i.test(message)) {
      return 'Camera access was denied. Please allow camera permissions and try again.';
    }
    if (name === 'NotFoundError' || /no camera/i.test(message)) {
      return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError') {
      return 'The camera is already in use by another application.';
    }
    return 'Unable to access the camera. Please check permissions and try again.';
  }

  protected removeScan(id: number): void {
    this.scannedCodes.set(this.scannedCodes().filter((c) => c.id !== id));
  }

  protected clearAll(): void {
    this.scannedCodes.set([]);
    this.downloadName.set(DEFAULT_DOWNLOAD_NAME);
    this.receivedFiles.set([]);
    this.scanError.set('');
    this.gapWarning.set('');
    this.pendingBatch.set(null);
    this.lastScannedIndex = null;
    this.ignoredBatchId = null;
  }

  /** Clears every piece of data this page holds (input, QR codes, scans, combined text, clipboard). */
  protected async wipeEverything(): Promise<void> {
    await this.stopScan();
    this.clearAll();
    this.combinedText.set('');
    this.reset();
    if (this.isBrowser && this.copiedToClipboard) {
      this.copiedToClipboard = false;
      try {
        await navigator.clipboard.writeText('');
      } catch {
        // Clipboard may be unavailable without focus/permission.
      }
    }
  }

  protected async copyText(): Promise<void> {
    await this.copyToClipboard(this.combinedText());
  }

  protected async copyFile(file: TransferFile): Promise<void> {
    await this.copyToClipboard(file.text);
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (!this.isBrowser || !text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.copiedToClipboard = true;
      // Best-effort: don't leave the data sitting on the clipboard.
      setTimeout(() => {
        if (this.copiedToClipboard) {
          this.copiedToClipboard = false;
          void navigator.clipboard.writeText('').catch(() => undefined);
        }
      }, 30000);
    } catch {
      this.scanError.set('Failed to copy text to clipboard.');
    }
  }

  protected readonly downloadName = signal(DEFAULT_DOWNLOAD_NAME);

  protected onDownloadNameInput(event: Event): void {
    this.downloadName.set((event.target as HTMLInputElement).value);
  }

  protected downloadText(): void {
    if (!this.isBrowser || !this.combinedText()) {
      return;
    }
    // Default to .txt unless the user typed an extension.
    let name = safeFileName(this.downloadName() || DEFAULT_DOWNLOAD_NAME);
    if (!/\.[A-Za-z0-9]+$/.test(name)) {
      name += '.txt';
    }
    this.saveBlob(new Blob([this.combinedText()], { type: 'text/plain;charset=utf-8' }), name);
  }

  protected downloadFile(file: TransferFile): void {
    if (!this.isBrowser) {
      return;
    }
    this.saveBlob(new Blob([file.text], { type: 'text/plain;charset=utf-8' }), safeFileName(file.name));
  }

  protected downloadAllAsZip(): void {
    if (!this.isBrowser || this.receivedFiles().length === 0) {
      return;
    }
    const used = new Set<string>();
    const entries = this.receivedFiles().map((f) => {
      // Keep names unique inside the zip: "a.ts", "a (2).ts", ...
      const base = safeFileName(f.name);
      let name = base;
      for (let n = 2; used.has(name); n++) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
      }
      used.add(name);
      return { name, data: new TextEncoder().encode(f.text) };
    });
    this.saveBlob(buildZip(entries), 'files.zip');
  }

  private saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
