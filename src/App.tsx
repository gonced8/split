import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  ImageIcon,
  ReceiptText,
  ScanLine,
  Sparkles,
  Users,
  WandSparkles,
  X,
} from 'lucide-react';
import Tesseract from 'tesseract.js';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { Input } from './components/ui/input';
import { parseReceipt, type ReceiptItem, uid } from './lib/receipt';
import { computeSplitTotals, type Person } from './lib/split';

type Corner = { x: number; y: number };
type Step = 1 | 2 | 3;

const stepMeta: Record<Step, { label: string; title: string; icon: typeof Camera }> = {
  1: { label: 'Capture', title: 'Scan receipt', icon: Camera },
  2: { label: 'Review', title: 'Fix extracted items', icon: ReceiptText },
  3: { label: 'Split', title: 'Share the bill', icon: Users },
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatMoney(value: number) {
  return `€${value.toFixed(2)}`;
}

function solveLinear(A: number[][], b: number[]) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let r = i + 1; r < n; r++) {
      if (Math.abs(A[r][i]) > Math.abs(A[maxRow][i])) maxRow = r;
    }
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    [b[i], b[maxRow]] = [b[maxRow], b[i]];

    const pivot = A[i][i] || 1e-12;
    for (let j = i; j < n; j++) A[i][j] /= pivot;
    b[i] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = A[r][i];
      for (let c = i; c < n; c++) A[r][c] -= factor * A[i][c];
      b[r] -= factor * b[i];
    }
  }
  return b;
}

function getHomography(src: Corner[], dst: Corner[]) {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const u = dst[i].x;
    const v = dst[i].y;

    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinear(A, b);
  return [h11, h12, h13, h21, h22, h23, h31, h32, 1];
}

function invert3x3(m: number[]) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det];
}

function project(m: number[], x: number, y: number) {
  const w = m[6] * x + m[7] * y + m[8];
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
  };
}

function bilinearSample(data: Uint8ClampedArray, w: number, h: number, x: number, y: number) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const x1 = clamp(x0 + 1, 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const y1 = clamp(y0 + 1, 0, h - 1);
  const dx = x - x0;
  const dy = y - y0;

  const idx = (xx: number, yy: number) => (yy * w + xx) * 4;
  const i00 = idx(x0, y0);
  const i10 = idx(x1, y0);
  const i01 = idx(x0, y1);
  const i11 = idx(x1, y1);

  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    out[c] =
      data[i00 + c] * (1 - dx) * (1 - dy) +
      data[i10 + c] * dx * (1 - dy) +
      data[i01 + c] * (1 - dx) * dy +
      data[i11 + c] * dx * dy;
  }
  return out;
}

async function buildOcrVariants(inputDataUrl: string) {
  return new Promise<string[]>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.max(2, 2200 / Math.max(img.width, 1));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const baseCanvas = document.createElement('canvas');
      baseCanvas.width = w;
      baseCanvas.height = h;
      const ctx = baseCanvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));

      ctx.filter = 'contrast(130%) brightness(108%) saturate(0%)';
      ctx.drawImage(img, 0, 0, w, h);
      ctx.filter = 'none';
      const imageData = ctx.getImageData(0, 0, w, h);
      const d = imageData.data;
      let minGray = 255;
      let maxGray = 0;
      let sumGray = 0;

      for (let i = 0; i < d.length; i += 4) {
        const gray = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
        minGray = Math.min(minGray, gray);
        maxGray = Math.max(maxGray, gray);
        sumGray += gray;
      }

      const meanGray = sumGray / (d.length / 4);
      const contrastRange = Math.max(1, maxGray - minGray);
      const adaptiveThreshold = clamp(meanGray * 0.92, 115, 205);

      const normalized = ctx.createImageData(w, h);
      const binary = ctx.createImageData(w, h);

      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        const stretched = clamp(((gray - minGray) / contrastRange) * 255, 0, 255);
        const sharpened = clamp(gray + (gray - meanGray) * 0.25, 0, 255);
        const normalizedGray = Math.round(stretched * 0.6 + sharpened * 0.4);
        const bw = normalizedGray > adaptiveThreshold ? 255 : 0;

        normalized.data[i] = normalizedGray;
        normalized.data[i + 1] = normalizedGray;
        normalized.data[i + 2] = normalizedGray;
        normalized.data[i + 3] = 255;

        binary.data[i] = bw;
        binary.data[i + 1] = bw;
        binary.data[i + 2] = bw;
        binary.data[i + 3] = 255;
      }

      const grayscaleCanvas = document.createElement('canvas');
      grayscaleCanvas.width = w;
      grayscaleCanvas.height = h;
      grayscaleCanvas.getContext('2d')?.putImageData(normalized, 0, 0);

      const binaryCanvas = document.createElement('canvas');
      binaryCanvas.width = w;
      binaryCanvas.height = h;
      binaryCanvas.getContext('2d')?.putImageData(binary, 0, 0);

      resolve([
        binaryCanvas.toDataURL('image/png'),
        grayscaleCanvas.toDataURL('image/png'),
        baseCanvas.toDataURL('image/png'),
        inputDataUrl,
      ]);
    };
    img.onerror = () => reject(new Error('Failed to load image for OCR preprocess'));
    img.src = inputDataUrl;
  });
}

function scoreParsedReceipt(parsed: { items: ReceiptItem[]; total: number }) {
  const subtotal = parsed.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const nameScore = parsed.items.reduce((sum, item) => sum + Math.min(item.name.length, 22), 0);
  const totalScore = parsed.total > 0 ? 18 : 0;
  const countScore = parsed.items.length * 24;
  const deltaPenalty = parsed.total > 0 ? Math.min(Math.abs(parsed.total - subtotal) * 12, 24) : 0;
  return countScore + nameScore + totalScore - deltaPenalty;
}

function App() {
  const [step, setStep] = useState<Step>(1);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [processedDataUrl, setProcessedDataUrl] = useState<string | null>(null);
  const [corners, setCorners] = useState<Corner[]>([]);
  const dragCornerRef = useRef<number | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [brightness, setBrightness] = useState(108);
  const [contrast, setContrast] = useState(132);
  const [saturation, setSaturation] = useState(85);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState('');
  const [detectedTotal, setDetectedTotal] = useState(0);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [people, setPeople] = useState<Person[]>([
    { id: uid('p'), name: 'Alex' },
    { id: uid('p'), name: 'Sam' },
  ]);
  const [tipMode, setTipMode] = useState<'percent' | 'fixed'>('percent');
  const [tipValue, setTipValue] = useState(10);
  const [alloc, setAlloc] = useState<Record<string, Record<string, number>>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const subtotal = useMemo(() => items.reduce((sum, item) => sum + item.price * item.quantity, 0), [items]);
  const receiptTotal = detectedTotal || subtotal;
  const tipAmount = tipMode === 'percent' ? subtotal * (tipValue / 100) : tipValue;
  const grandTotal = subtotal + tipAmount;
  const personTotals = useMemo(
    () => computeSplitTotals(people, items, alloc, tipAmount),
    [people, items, alloc, tipAmount],
  );
  const splitAssignedValue = useMemo(
    () =>
      items.reduce((sum, item) => {
        const assigned = people.reduce((inner, person) => inner + (alloc[item.id]?.[person.id] || 0), 0);
        return sum + (assigned > 0 ? item.price * item.quantity : 0);
      }, 0),
    [alloc, items, people],
  );
  const completion = useMemo(() => {
    if (!items.length) return 0;
    const assignedItems = items.filter((item) =>
      people.some((person) => (alloc[item.id]?.[person.id] || 0) > 0),
    ).length;
    return assignedItems / items.length;
  }, [alloc, items, people]);

  const onFile = (file?: File) => {
    if (!file) return;
    setOcrError(null);
    setOcrText('');
    setItems([]);
    setAlloc({});
    setDetectedTotal(0);
    setProcessedDataUrl(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImageEl(img);
      setCorners([
        { x: 0, y: 0 },
        { x: img.width, y: 0 },
        { x: img.width, y: img.height },
        { x: 0, y: img.height },
      ]);
    };
    img.src = url;
  };

  useEffect(() => {
    if (!imageEl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const maxW = 960;
    const scale = Math.min(1, maxW / imageEl.width);
    canvas.width = imageEl.width * scale;
    canvas.height = imageEl.height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    ctx.drawImage(imageEl, 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';

    if (corners.length === 4) {
      const scaled = corners.map((corner) => ({ x: corner.x * scale, y: corner.y * scale }));
      ctx.strokeStyle = '#14b8a6';
      ctx.fillStyle = 'rgba(20, 184, 166, 0.14)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      scaled.forEach((corner, index) => (index ? ctx.lineTo(corner.x, corner.y) : ctx.moveTo(corner.x, corner.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }, [imageEl, corners, brightness, contrast, saturation]);

  const moveCornerFromPointer = (
    cornerIndex: number,
    clientX: number,
    clientY: number,
    offset = { x: 0, y: 0 },
  ) => {
    if (!imageEl || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const xDisplay = clamp(clientX - rect.left - offset.x, 0, rect.width);
    const yDisplay = clamp(clientY - rect.top - offset.y, 0, rect.height);

    const x = (xDisplay / rect.width) * imageEl.width;
    const y = (yDisplay / rect.height) * imageEl.height;
    setCorners((prev) => prev.map((corner, index) => (index === cornerIndex ? { x, y } : corner)));
  };

  const flattenAndEnhance = () => {
    if (!imageEl || corners.length !== 4) return;

    const width = Math.max(
      640,
      Math.round(
        (Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) +
          Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y)) /
          2,
      ),
    );
    const height = Math.max(
      900,
      Math.round(
        (Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) +
          Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y)) /
          2,
      ),
    );

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = imageEl.width;
    srcCanvas.height = imageEl.height;
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) return;
    srcCtx.drawImage(imageEl, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = width;
    dstCanvas.height = height;
    const dstCtx = dstCanvas.getContext('2d');
    if (!dstCtx) return;

    const H = getHomography(corners, [
      { x: 0, y: 0 },
      { x: width - 1, y: 0 },
      { x: width - 1, y: height - 1 },
      { x: 0, y: height - 1 },
    ]);
    const Hinv = invert3x3(H);
    const out = dstCtx.createImageData(width, height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = project(Hinv, x, y);
        const [r, g, b, a] = bilinearSample(srcData.data, srcCanvas.width, srcCanvas.height, p.x, p.y);
        const idx = (y * width + x) * 4;
        out.data[idx] = r;
        out.data[idx + 1] = g;
        out.data[idx + 2] = b;
        out.data[idx + 3] = a;
      }
    }

    dstCtx.putImageData(out, 0, 0);
    dstCtx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
    dstCtx.drawImage(dstCanvas, 0, 0);
    setProcessedDataUrl(dstCanvas.toDataURL('image/png'));
  };

  const runOcr = async () => {
    if (!processedDataUrl) return;
    setOcrLoading(true);
    setOcrError(null);

    try {
      const variants = await buildOcrVariants(processedDataUrl);
      const attempts = [];

      for (const variant of variants) {
        const result = await Tesseract.recognize(variant, 'eng+por');
        const parsed = parseReceipt(result.data.text);
        attempts.push({ parsed, text: result.data.text });
        if (parsed.items.length >= 4) break;
      }

      const best = attempts
        .map((attempt) => ({ ...attempt, score: scoreParsedReceipt(attempt.parsed) }))
        .sort((a, b) => b.score - a.score)[0];

      if (!best) throw new Error('No OCR attempts completed');

      setOcrText(best.text);
      setDetectedTotal(best.parsed.total);

      if (!best.parsed.items.length) {
        setOcrError('Could not detect line items. The raw text is available below and you can still add items manually.');
      }

      setItems(
        best.parsed.items.length ? best.parsed.items : [{ id: uid('item'), name: 'Manual item', quantity: 1, price: 0 }],
      );
      setStep(2);
    } catch {
      setOcrError('OCR failed on this image. Try recropping the receipt, switching to high contrast, and extracting again.');
    } finally {
      setOcrLoading(false);
    }
  };

  const removeItem = (itemId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== itemId));
    setAlloc((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  };

  const updateItem = (itemId: string, patch: Partial<ReceiptItem>) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, ...patch } : item)));
  };

  const updatePeopleCount = (nextCount: number) => {
    setPeople((prev) => {
      if (nextCount <= prev.length) return prev;
      const next = [...prev];
      while (next.length < nextCount) {
        next.push({ id: uid('p'), name: `Person ${next.length + 1}` });
      }
      return next;
    });
  };

  const setItemSplitEvenly = (itemId: string) => {
    const share = 1;
    setAlloc((prev) => ({
      ...prev,
      [itemId]: Object.fromEntries(people.map((person) => [person.id, share])),
    }));
  };

  const assignItemToPerson = (itemId: string, personId: string) => {
    setAlloc((prev) => ({
      ...prev,
      [itemId]: Object.fromEntries(people.map((person) => [person.id, person.id === personId ? 1 : 0])),
    }));
  };

  const currentStep = stepMeta[step];
  const splitAllEvenly = () => {
    setAlloc((prev) => ({
      ...prev,
      ...Object.fromEntries(items.map((item) => [item.id, Object.fromEntries(people.map((person) => [person.id, 1]))])),
    }));
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(94,234,212,0.22),_transparent_32%),linear-gradient(180deg,_#f8fffe_0%,_#eef6f4_45%,_#e7efec_100%)] text-slate-900">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pb-28 pt-5 sm:px-6 lg:px-8">
        <header className="space-y-4">
          <div className="rounded-[28px] border border-white/70 bg-white/80 p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-teal-700">Split bills fast</p>
                <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Built for receipt-first bill splitting on mobile.</h1>
                <p className="max-w-2xl text-sm leading-6 text-slate-600">
                  Capture a receipt, clean the extraction, then assign items with large touch targets instead of fighting a spreadsheet.
                </p>
              </div>
              <div className="hidden rounded-3xl bg-slate-950 px-4 py-3 text-right text-white sm:block">
                <div className="text-xs uppercase tracking-[0.2em] text-teal-300">Current total</div>
                <div className="mt-1 text-2xl font-semibold">{formatMoney(grandTotal || receiptTotal)}</div>
                <div className="text-xs text-slate-300">{items.length} items · {people.length} people</div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {(Object.entries(stepMeta) as Array<[string, (typeof stepMeta)[Step]]>).map(([key, meta]) => {
                const numericStep = Number(key) as Step;
                const Icon = meta.icon;
                const active = step === numericStep;
                const complete = step > numericStep;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStep(numericStep)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      active
                        ? 'border-teal-400 bg-teal-50 shadow-[0_10px_30px_rgba(20,184,166,0.16)]'
                        : complete
                          ? 'border-emerald-200 bg-emerald-50/80'
                          : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex size-11 items-center justify-center rounded-2xl ${
                          active ? 'bg-teal-600 text-white' : complete ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        <Icon className="size-5" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{meta.label}</p>
                        <p className="text-base font-semibold text-slate-900">{meta.title}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <main className="space-y-4">
            <Card className="overflow-hidden border-white/70 bg-white/85">
              <CardContent className="space-y-5 p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">Step {step}</p>
                    <h2 className="text-xl font-semibold text-slate-950">{currentStep.title}</h2>
                  </div>
                  <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                    {Math.round(completion * 100)}% allocated
                  </div>
                </div>

                {step === 1 && (
                  <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="flex cursor-pointer items-center justify-between rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4 text-left transition hover:border-teal-300 hover:bg-white">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Take photo</p>
                          <p className="text-xs text-slate-500">Opens camera directly on mobile.</p>
                        </div>
                        <div className="flex size-11 items-center justify-center rounded-2xl bg-teal-600 text-white">
                          <Camera className="size-5" />
                        </div>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => onFile(e.target.files?.[0])}
                        />
                      </label>

                      <label className="flex cursor-pointer items-center justify-between rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4 text-left transition hover:border-teal-300 hover:bg-white">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Upload photo</p>
                          <p className="text-xs text-slate-500">Pick from photo library/files.</p>
                        </div>
                        <div className="flex size-11 items-center justify-center rounded-2xl bg-slate-700 text-white">
                          <ImageIcon className="size-5" />
                        </div>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => onFile(e.target.files?.[0])}
                        />
                      </label>

                      <div className="rounded-3xl border border-slate-200 bg-slate-50 px-4 py-4">
                        <p className="text-sm font-semibold text-slate-900">Receipt scan tips</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">
                          Keep the full paper inside frame, avoid shadows, and tap corners tightly before extracting text.
                        </p>
                      </div>
                    </div>

                    {imageEl && (
                      <div className="space-y-4">
                        <div
                          ref={overlayRef}
                          className="relative isolate overflow-hidden rounded-[28px] border border-slate-200 bg-slate-950/5 touch-none"
                          onPointerMove={(e) => {
                            if (dragCornerRef.current === null) return;
                            moveCornerFromPointer(dragCornerRef.current, e.clientX, e.clientY, dragOffsetRef.current);
                          }}
                          onPointerUp={(e) => {
                            dragCornerRef.current = null;
                            overlayRef.current?.releasePointerCapture(e.pointerId);
                          }}
                          onPointerCancel={() => {
                            dragCornerRef.current = null;
                          }}
                        >
                          <canvas ref={canvasRef} className="block w-full" />
                          {corners.map((corner, index) => {
                            const leftPct = (corner.x / imageEl.width) * 100;
                            const topPct = (corner.y / imageEl.height) * 100;
                            return (
                              <button
                                key={index}
                                type="button"
                                aria-label={`corner-${index + 1}`}
                                className="absolute size-11 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-teal-500 shadow-[0_10px_30px_rgba(13,148,136,0.35)]"
                                style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                                onPointerDown={(e) => {
                                  e.preventDefault();
                                  if (!overlayRef.current) return;
                                  const rect = overlayRef.current.getBoundingClientRect();
                                  const cornerX = (corner.x / imageEl.width) * rect.width;
                                  const cornerY = (corner.y / imageEl.height) * rect.height;
                                  dragOffsetRef.current = {
                                    x: e.clientX - rect.left - cornerX,
                                    y: e.clientY - rect.top - cornerY,
                                  };
                                  dragCornerRef.current = index;
                                  overlayRef.current.setPointerCapture(e.pointerId);
                                }}
                              />
                            );
                          })}
                          <div className="absolute bottom-3 left-3 rounded-full bg-slate-950/70 px-3 py-1 text-xs text-white backdrop-blur">
                            Drag all four corners to match the receipt edges.
                          </div>
                        </div>

                        <div className="grid gap-3">
                          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                            <div className="mb-3 flex flex-wrap gap-2">
                              <Button type="button" variant="outline" onClick={() => {
                                setBrightness(102);
                                setContrast(118);
                                setSaturation(100);
                              }}>
                                Natural
                              </Button>
                              <Button type="button" variant="outline" onClick={() => {
                                setBrightness(110);
                                setContrast(145);
                                setSaturation(40);
                              }}>
                                <ScanLine className="mr-2 size-4" /> High contrast
                              </Button>
                              <Button type="button" variant="outline" onClick={() => {
                                setBrightness(118);
                                setContrast(128);
                                setSaturation(0);
                              }}>
                                <WandSparkles className="mr-2 size-4" /> Faded paper
                              </Button>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                              {[
                                { label: 'Brightness', value: brightness, setValue: setBrightness },
                                { label: 'Contrast', value: contrast, setValue: setContrast },
                                { label: 'Saturation', value: saturation, setValue: setSaturation },
                              ].map(({ label, value, setValue }) => (
                                <label key={label} className="text-sm font-medium text-slate-700">
                                  <div className="mb-2 flex items-center justify-between">
                                    <span>{label}</span>
                                    <span className="text-xs text-slate-500">{value}%</span>
                                  </div>
                                  <input
                                    className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200"
                                    type="range"
                                    min={50}
                                    max={200}
                                    value={value}
                                    onChange={(e) => setValue(Number(e.target.value))}
                                  />
                                </label>
                              ))}
                            </div>
                          </div>

                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Button type="button" className="h-12 flex-1 rounded-2xl" onClick={flattenAndEnhance}>
                              <Sparkles className="mr-2 size-4" /> Flatten and enhance
                            </Button>
                            <Button
                              type="button"
                              className="h-12 flex-1 rounded-2xl"
                              onClick={runOcr}
                              disabled={!processedDataUrl || ocrLoading}
                            >
                              {ocrLoading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ReceiptText className="mr-2 size-4" />}
                              Extract text
                            </Button>
                          </div>

                          {ocrError && <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{ocrError}</p>}

                          {processedDataUrl && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-semibold text-slate-900">Processed preview</p>
                                <p className="text-xs text-slate-500">This version is used for OCR.</p>
                              </div>
                              <img
                                src={processedDataUrl}
                                className="max-h-[28rem] w-full rounded-[24px] border border-slate-200 bg-white object-contain"
                                alt="Processed receipt"
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {step === 2 && (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Items</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{items.length}</p>
                      </div>
                      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Subtotal</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{formatMoney(subtotal)}</p>
                      </div>
                      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Detected total</p>
                        <p className="mt-2 text-2xl font-semibold text-slate-950">{formatMoney(receiptTotal)}</p>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {items.map((item, index) => (
                        <div key={item.id} className="rounded-[26px] border border-slate-200 bg-slate-50/80 p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <p className="text-sm font-semibold text-slate-900">Item {index + 1}</p>
                            <button
                              type="button"
                              className="rounded-full p-2 text-slate-400 transition hover:bg-white hover:text-rose-600"
                              onClick={() => removeItem(item.id)}
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px_120px]">
                            <Input value={item.name} onChange={(e) => updateItem(item.id, { name: e.target.value })} />
                            <Input
                              type="number"
                              step="0.1"
                              min="0"
                              value={item.quantity}
                              onChange={(e) => updateItem(item.id, { quantity: Number(e.target.value || 0) })}
                            />
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.price}
                              onChange={(e) => updateItem(item.id, { price: Number(e.target.value || 0) })}
                            />
                          </div>
                          <p className="mt-3 text-sm text-slate-500">Line total: {formatMoney(item.quantity * item.price)}</p>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12 rounded-2xl"
                        onClick={() => setItems((prev) => [...prev, { id: uid('item'), name: 'New item', quantity: 1, price: 0 }])}
                      >
                        <Plus className="mr-2 size-4" /> Add item
                      </Button>
                      <Button type="button" variant="outline" className="h-12 rounded-2xl" onClick={() => setStep(3)}>
                        Continue to split <ChevronRight className="ml-2 size-4" />
                      </Button>
                    </div>

                    {ocrText && (
                      <details className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                        <summary className="cursor-pointer text-sm font-semibold text-slate-900">View raw OCR text</summary>
                        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-600">{ocrText}</pre>
                      </details>
                    )}
                  </div>
                )}

                {step === 3 && (
                  <div className="space-y-5">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                      <div className="space-y-4 rounded-[28px] border border-slate-200 bg-slate-50 p-4">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">People</p>
                          <p className="text-xs leading-5 text-slate-500">Rename diners and add more if needed.</p>
                        </div>
                        <div className="space-y-2">
                          {people.map((person) => (
                            <Input
                              key={person.id}
                              value={person.name}
                              onChange={(e) =>
                                setPeople((prev) =>
                                  prev.map((entry) => (entry.id === person.id ? { ...entry, name: e.target.value } : entry)),
                                )
                              }
                            />
                          ))}
                        </div>
                        <Button type="button" variant="outline" className="h-11 rounded-2xl" onClick={() => updatePeopleCount(people.length + 1)}>
                          <Plus className="mr-2 size-4" /> Add person
                        </Button>

                        <div className="rounded-3xl bg-white p-4">
                          <p className="text-sm font-semibold text-slate-900">Tip</p>
                          <div className="mt-3 flex items-center gap-2">
                            <Button type="button" variant={tipMode === 'percent' ? 'default' : 'outline'} onClick={() => setTipMode('percent')}>
                              %
                            </Button>
                            <Button type="button" variant={tipMode === 'fixed' ? 'default' : 'outline'} onClick={() => setTipMode('fixed')}>
                              €
                            </Button>
                            <Input
                              className="max-w-[8rem]"
                              type="number"
                              step="0.5"
                              min="0"
                              value={tipValue}
                              onChange={(e) => setTipValue(Number(e.target.value || 0))}
                            />
                          </div>
                          <p className="mt-3 text-sm text-slate-500">Tip amount: {formatMoney(tipAmount)}</p>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="outline" className="rounded-2xl" onClick={splitAllEvenly}>
                            Split all evenly
                          </Button>
                        </div>

                        {items.map((item) => {
                          const itemAlloc = alloc[item.id] || {};
                          const assignedTotal = people.reduce((sum, person) => sum + (itemAlloc[person.id] || 0), 0);
                          return (
                            <div key={item.id} className="rounded-[28px] border border-slate-200 bg-slate-50/90 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-base font-semibold text-slate-950">{item.name}</p>
                                  <p className="text-sm text-slate-500">
                                    {item.quantity} × {formatMoney(item.price)} = {formatMoney(item.quantity * item.price)}
                                  </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Button type="button" variant="outline" className="rounded-2xl" onClick={() => setItemSplitEvenly(item.id)}>
                                    Even split
                                  </Button>
                                  {people.slice(0, 3).map((person) => (
                                    <Button
                                      key={person.id}
                                      type="button"
                                      variant="outline"
                                      className="rounded-2xl"
                                      onClick={() => assignItemToPerson(item.id, person.id)}
                                    >
                                      {person.name}
                                    </Button>
                                  ))}
                                </div>
                              </div>

                              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                {people.map((person) => (
                                  <label key={person.id} className="rounded-3xl border border-white bg-white p-3">
                                    <div className="mb-2 text-sm font-medium text-slate-700">{person.name}</div>
                                    <Input
                                      type="number"
                                      step="0.1"
                                      min="0"
                                      value={itemAlloc[person.id] ?? 0}
                                      onChange={(e) =>
                                        setAlloc((prev) => ({
                                          ...prev,
                                          [item.id]: {
                                            ...(prev[item.id] || {}),
                                            [person.id]: Number(e.target.value || 0),
                                          },
                                        }))
                                      }
                                    />
                                  </label>
                                ))}
                              </div>

                              <p className="mt-3 text-sm text-slate-500">
                                {assignedTotal > 0
                                  ? `Assigned in ${assignedTotal.toFixed(1)} share${assignedTotal === 1 ? '' : 's'}.`
                                  : 'No one has been assigned to this item yet.'}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </main>

          <aside className="space-y-4">
            <Card className="border-slate-900 bg-slate-950 text-white">
              <CardContent className="space-y-4 p-5">
                <div>
                  <p className="text-xs uppercase tracking-[0.22em] text-teal-300">Summary</p>
                  <h3 className="mt-2 text-xl font-semibold">Who owes what</h3>
                </div>
                <div className="grid gap-3">
                  {people.map((person) => (
                    <div key={person.id} className="rounded-3xl bg-white/8 p-4">
                      <div className="text-sm text-slate-300">{person.name}</div>
                      <div className="mt-1 text-2xl font-semibold">{formatMoney(personTotals[person.id] || 0)}</div>
                    </div>
                  ))}
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                  <div className="flex items-center justify-between">
                    <span>Subtotal</span>
                    <span>{formatMoney(subtotal)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span>Tip</span>
                    <span>{formatMoney(tipAmount)}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-white">
                    <span>Total</span>
                    <span>{formatMoney(grandTotal)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/70 bg-white/80">
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center justify-between text-sm text-slate-600">
                  <span>Allocation progress</span>
                  <span>{Math.round(completion * 100)}%</span>
                </div>
                <div className="h-3 rounded-full bg-slate-200">
                  <div className="h-3 rounded-full bg-teal-500 transition-all" style={{ width: `${completion * 100}%` }} />
                </div>
                <p className="text-sm text-slate-500">
                  Assigned value: {formatMoney(splitAssignedValue)} of {formatMoney(subtotal)}
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-12 min-w-[7.5rem] rounded-2xl"
            disabled={step === 1}
            onClick={() => setStep((current) => Math.max(1, current - 1) as Step)}
          >
            <ChevronLeft className="mr-2 size-4" /> Back
          </Button>
          <div className="text-right">
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{currentStep.label}</p>
            <p className="text-sm font-semibold text-slate-900">{currentStep.title}</p>
          </div>
          <Button
            type="button"
            className="h-12 min-w-[7.5rem] rounded-2xl"
            disabled={(step === 1 && !processedDataUrl) || (step === 2 && items.length === 0) || step === 3}
            onClick={() => setStep((current) => Math.min(3, current + 1) as Step)}
          >
            Next <ChevronRight className="ml-2 size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default App;
