import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  ReceiptText,
  ScanLine,
  Sparkles,
  Users,
  WandSparkles,
  X,
  Check,
} from 'lucide-react';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { Input } from './components/ui/input';
import { type ReceiptItem, uid } from './lib/receipt';
import { computeSplitTotals, type Person } from './lib/split';
import { getGeminiMode, parseReceiptWithGemini } from './lib/gemini';

type Corner = { x: number; y: number };
type Step = 1 | 2 | 3;

const stepMeta: Record<Step, { label: string; title: string; icon: typeof Camera }> = {
  1: { label: 'Scan', title: 'Upload receipt', icon: Camera },
  2: { label: 'Review', title: 'Check items', icon: ReceiptText },
  3: { label: 'Split', title: 'Divide the bill', icon: Users },
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatMoney(value: number, currency = '€') {
  return `${currency}${value.toFixed(2)}`;
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

function flattenImage(
  imageEl: HTMLImageElement,
  corners: Corner[],
): string | null {
  if (corners.length !== 4) return null;

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
  if (!srcCtx) return null;
  srcCtx.drawImage(imageEl, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = width;
  dstCanvas.height = height;
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) return null;

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
  return dstCanvas.toDataURL('image/jpeg', 0.85);
}

function App() {
  const [step, setStep] = useState<Step>(1);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [corners, setCorners] = useState<Corner[]>([]);
  const dragCornerRef = useRef<number | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [currency, setCurrency] = useState('€');
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [people, setPeople] = useState<Person[]>([
    { id: uid('p'), name: 'A' },
    { id: uid('p'), name: 'B' },
  ]);
  const [tipMode, setTipMode] = useState<'percent' | 'fixed'>('percent');
  const [tipValue, setTipValue] = useState(10);
  const [alloc, setAlloc] = useState<Record<string, Record<string, number>>>({});
  const [detectedTotal, setDetectedTotal] = useState(0);

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
    setExtractError(null);
    setItems([]);
    setAlloc({});
    setDetectedTotal(0);
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
    ctx.drawImage(imageEl, 0, 0, canvas.width, canvas.height);

    if (corners.length === 4) {
      const scaled = corners.map((corner) => ({ x: corner.x * scale, y: corner.y * scale }));
      ctx.strokeStyle = '#14b8a6';
      ctx.fillStyle = 'rgba(20, 184, 166, 0.10)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      scaled.forEach((corner, index) => (index ? ctx.lineTo(corner.x, corner.y) : ctx.moveTo(corner.x, corner.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }, [imageEl, corners]);

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

  const applyFilterToDataUrl = (dataUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        if (!ctx) {
          reject(new Error('No canvas context'));
          return;
        }
        ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
        ctx.drawImage(img, 0, 0);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  };

  const extractItems = async () => {
    if (!imageEl || corners.length !== 4) return;

    setExtracting(true);
    setExtractError(null);

    try {
      const flattenedUrl = flattenImage(imageEl, corners);
      if (!flattenedUrl) throw new Error('Failed to process image.');

      const filteredUrl = await applyFilterToDataUrl(flattenedUrl);
      const result = await parseReceiptWithGemini(filteredUrl);
      setCurrency(result.currency === 'USD' ? '$' : result.currency === 'GBP' ? '£' : '€');
      setDetectedTotal(result.total);

      if (!result.items.length) {
        setExtractError('No items detected. You can add them manually.');
        setItems([{ id: uid('item'), name: 'New item', quantity: 1, price: 0 }]);
      } else {
        setItems(result.items);
      }
      setStep(2);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : 'Extraction failed. Try again.');
    } finally {
      setExtracting(false);
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
        next.push({ id: uid('p'), name: String.fromCharCode(65 + next.length) });
      }
      return next;
    });
  };

  const setItemSplitEvenly = (itemId: string) => {
    setAlloc((prev) => ({
      ...prev,
      [itemId]: Object.fromEntries(people.map((person) => [person.id, 1])),
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

  const nextDisabled =
    step === 1 ||
    (step === 2 && items.length === 0) ||
    step === 3;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(94,234,212,0.18),_transparent_28%),linear-gradient(180deg,_#f8fffe_0%,_#eef6f4_45%,_#e7efec_100%)] text-slate-900">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pb-28 pt-5 sm:px-6 lg:px-8">

        {/* Header */}
        <header>
          <div className="rounded-[28px] border border-white/70 bg-white/80 p-5 shadow-[0_20px_60px_rgba(15,23,42,0.06)] backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Split</h1>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  Snap a receipt, extract items with AI, split the bill.
                  <span
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
                    title={getGeminiMode() === 'direct' ? 'Using your API key (VITE_GEMINI_API_KEY)' : 'Using Worker proxy (VITE_PROXY_URL)'}
                  >
                    API: {getGeminiMode() === 'direct' ? 'Direct' : 'Proxy'}
                  </span>
                </p>
              </div>
              {step !== 1 && (
                <div className="hidden rounded-3xl border border-teal-200 bg-teal-50 px-4 py-3 text-right sm:block">
                  <div className="text-xs font-medium uppercase tracking-[0.2em] text-teal-600">Total</div>
                  <div className="mt-1 text-xl font-semibold text-slate-900">{formatMoney(grandTotal || receiptTotal, currency)}</div>
                </div>
              )}
            </div>

            {/* Step indicators */}
            <div className="mt-4 grid grid-cols-3 gap-2">
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
                    className={`flex flex-col items-center gap-2 rounded-2xl border p-3 text-center transition sm:gap-2.5 sm:p-4 ${
                      active
                        ? 'border-teal-400 bg-teal-50 shadow-[0_8px_24px_rgba(20,184,166,0.14)]'
                        : complete
                          ? 'border-emerald-200 bg-emerald-50/80'
                          : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div
                      className={`flex size-10 shrink-0 items-center justify-center rounded-xl sm:size-11 sm:rounded-2xl ${
                        active ? 'bg-teal-600 text-white' : complete ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {complete ? <Check className="size-5 sm:size-5" /> : <Icon className="size-5 sm:size-5" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{meta.label}</p>
                      <p className="mt-0.5 hidden text-sm font-semibold text-slate-900 sm:block">{meta.title}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        {/* Content */}
        <div className={`grid gap-4 ${step === 3 ? 'lg:grid-cols-[minmax(0,1fr)_320px]' : ''}`}>
          <main className="space-y-4">
            <Card className="overflow-hidden border-white/70 bg-white/85">
              <CardContent className="space-y-5 p-5">
                {step !== 1 && (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">Step {step}</p>
                      <h2 className="text-xl font-semibold text-slate-950">{currentStep.title}</h2>
                    </div>
                    {step === 3 && (
                      <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                        {Math.round(completion * 100)}% allocated
                      </div>
                    )}
                  </div>
                )}

                {/* Step 1: Capture */}
                {step === 1 && (
                  <div className="space-y-5">
                    {!imageEl ? (
                      <label className="flex cursor-pointer flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-slate-200 bg-slate-50/50 p-10 text-center transition hover:border-teal-300 hover:bg-white">
                        <div className="flex size-16 items-center justify-center rounded-3xl bg-teal-600 text-white shadow-[0_12px_36px_rgba(13,148,136,0.25)]">
                          <Camera className="size-7" />
                        </div>
                        <div>
                          <p className="text-base font-semibold text-slate-900">Take a photo or upload a receipt</p>
                          <p className="mt-1 text-sm text-slate-500">JPEG, PNG, HEIC supported</p>
                        </div>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            onFile(e.target.files?.[0]);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    ) : (
                      <div className="space-y-4">
                        {/* Image crop area */}
                        <div className="p-6">
                          <div
                            ref={overlayRef}
                            className="relative isolate overflow-visible rounded-[20px] border border-slate-200 bg-slate-950/5 touch-none"
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
                            <div
                              className="block w-full rounded-[20px]"
                              style={{
                                filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`,
                              }}
                            >
                              <canvas ref={canvasRef} className="block w-full rounded-[20px]" />
                            </div>
                            {corners.map((corner, index) => {
                              const leftPct = (corner.x / imageEl.width) * 100;
                              const topPct = (corner.y / imageEl.height) * 100;
                              return (
                                <button
                                  key={index}
                                  type="button"
                                  aria-label={`corner-${index + 1}`}
                                  className="absolute z-10 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-teal-500 shadow-[0_8px_24px_rgba(13,148,136,0.3)] transition-transform active:scale-110"
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
                          </div>
                        </div>

                        {/* Brightness / contrast / saturation */}
                        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                          <p className="mb-3 text-sm font-semibold text-slate-900">Adjust image</p>
                          <div className="mb-3 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-2xl"
                              onClick={() => {
                                setBrightness(102);
                                setContrast(118);
                                setSaturation(100);
                              }}
                            >
                              Natural
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-2xl"
                              onClick={() => {
                                setBrightness(110);
                                setContrast(145);
                                setSaturation(40);
                              }}
                            >
                              <ScanLine className="mr-2 size-4" /> High contrast
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="rounded-2xl"
                              onClick={() => {
                                setBrightness(118);
                                setContrast(128);
                                setSaturation(0);
                              }}
                            >
                              <WandSparkles className="mr-2 size-4" /> Faded paper
                            </Button>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-3">
                            {[
                              { label: 'Brightness', value: brightness, setValue: setBrightness, min: 50, max: 200 },
                              { label: 'Contrast', value: contrast, setValue: setContrast, min: 50, max: 200 },
                              { label: 'Saturation', value: saturation, setValue: setSaturation, min: 0, max: 100 },
                            ].map(({ label, value, setValue, min, max }) => (
                              <label key={label} className="text-sm font-medium text-slate-700">
                                <div className="mb-2 flex items-center justify-between">
                                  <span>{label}</span>
                                  <span className="text-xs text-slate-500">{value}%</span>
                                </div>
                                <input
                                  type="range"
                                  className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-200"
                                  min={min}
                                  max={max}
                                  value={value}
                                  onChange={(e) => setValue(Number(e.target.value))}
                                />
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <label className="flex h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 transition hover:border-teal-300 hover:bg-teal-50/60">
                            <Camera className="size-4" /> Change photo
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                onFile(e.target.files?.[0]);
                                e.target.value = '';
                              }}
                            />
                          </label>
                          <Button
                            type="button"
                            className="h-12 flex-1 rounded-2xl text-base"
                            onClick={extractItems}
                            disabled={extracting}
                          >
                            {extracting ? (
                              <>
                                <Loader2 className="mr-2 size-5 animate-spin" /> Extracting...
                              </>
                            ) : (
                              <>
                                <Sparkles className="mr-2 size-5" /> Extract items
                              </>
                            )}
                          </Button>
                        </div>

                        {extractError && (
                          <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                            {extractError}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Step 2: Review */}
                {step === 2 && (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Items</p>
                        <p className="mt-1 text-2xl font-semibold text-slate-950">{items.length}</p>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Total</p>
                        <p className="mt-1 text-2xl font-semibold text-slate-950">{formatMoney(receiptTotal, currency)}</p>
                      </div>
                    </div>

                    {detectedTotal > 0 && Math.abs(subtotal - detectedTotal) > 0.02 && (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        <p className="font-medium">Total doesn’t match</p>
                        <p className="mt-1 text-amber-700">
                          Extracted total from receipt is {formatMoney(detectedTotal, currency)}, but the sum of items is {formatMoney(subtotal, currency)}. Check the table and fix any missing or wrong lines.
                        </p>
                      </div>
                    )}

                    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 bg-slate-50/80">
                              <th className="w-10 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">#</th>
                              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Product</th>
                              <th className="w-24 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Qty</th>
                              <th className="w-28 px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">Line total</th>
                              <th className="w-12 px-2 py-3" aria-label="Remove" />
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((item, index) => (
                              <tr
                                key={item.id}
                                className="border-b border-slate-100 transition-colors last:border-b-0 hover:bg-slate-50/50"
                              >
                                <td className="px-4 py-2.5 text-slate-400">{index + 1}</td>
                                <td className="px-4 py-2">
                                  <Input
                                    value={item.name}
                                    onChange={(e) => updateItem(item.id, { name: e.target.value })}
                                    placeholder="Product name"
                                    className="h-10 border-slate-200 bg-white text-slate-900"
                                  />
                                </td>
                                <td className="px-4 py-2">
                                  <Input
                                    type="number"
                                    step="0.1"
                                    min="0"
                                    value={item.quantity}
                                    onChange={(e) => updateItem(item.id, { quantity: Number(e.target.value || 0) })}
                                    className="h-10 border-slate-200 bg-white text-slate-900"
                                  />
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={item.quantity > 0 ? item.quantity * item.price : item.price}
                                    onChange={(e) => {
                                      const lineTotal = Number(e.target.value || 0);
                                      const qty = item.quantity || 0;
                                      updateItem(item.id, { price: qty > 0 ? lineTotal / qty : lineTotal });
                                    }}
                                    className="h-10 w-28 border-slate-200 bg-white text-right text-slate-900"
                                  />
                                </td>
                                <td className="px-2 py-2">
                                  <button
                                    type="button"
                                    className="rounded-full p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                                    onClick={() => removeItem(item.id)}
                                    aria-label={`Remove ${item.name}`}
                                  >
                                    <X className="size-4" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12 rounded-2xl"
                        onClick={() => setItems((prev) => [...prev, { id: uid('item'), name: 'New item', quantity: 1, price: 0 }])}
                      >
                        <Plus className="mr-2 size-4" /> Add row
                      </Button>
                      <Button type="button" className="h-12 rounded-2xl" onClick={() => setStep(3)}>
                        Continue to split <ChevronRight className="ml-2 size-4" />
                      </Button>
                    </div>
                  </div>
                )}

                {/* Step 3: Split */}
                {step === 3 && (
                  <div className="space-y-5">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
                      <div className="space-y-4 rounded-[24px] border border-slate-200 bg-slate-50 p-4">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">People</p>
                          <p className="text-xs leading-5 text-slate-500">Rename or add diners.</p>
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
                        <Button type="button" variant="outline" className="h-11 w-full rounded-2xl" onClick={() => updatePeopleCount(people.length + 1)}>
                          <Plus className="mr-2 size-4" /> Add person
                        </Button>

                        <div className="rounded-2xl bg-white p-4">
                          <p className="text-sm font-semibold text-slate-900">Tip</p>
                          <div className="mt-3 flex items-center gap-2">
                            <Button type="button" variant={tipMode === 'percent' ? 'default' : 'outline'} onClick={() => setTipMode('percent')}>
                              %
                            </Button>
                            <Button type="button" variant={tipMode === 'fixed' ? 'default' : 'outline'} onClick={() => setTipMode('fixed')}>
                              {currency}
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
                          <p className="mt-2 text-sm text-slate-500">
                            Tip: {formatMoney(tipAmount, currency)}
                          </p>
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
                            <div key={item.id} className="rounded-[24px] border border-slate-200 bg-slate-50/90 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="text-base font-semibold text-slate-950">{item.name}</p>
                                  <p className="text-sm text-slate-500">
                                    {item.quantity} × {formatMoney(item.price, currency)} = {formatMoney(item.quantity * item.price, currency)}
                                  </p>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  <Button type="button" variant="outline" className="h-8 rounded-xl px-3 text-xs" onClick={() => setItemSplitEvenly(item.id)}>
                                    Even
                                  </Button>
                                  {people.map((person) => (
                                    <Button
                                      key={person.id}
                                      type="button"
                                      variant="outline"
                                      className="h-8 rounded-xl px-3 text-xs"
                                      onClick={() => assignItemToPerson(item.id, person.id)}
                                    >
                                      {person.name}
                                    </Button>
                                  ))}
                                </div>
                              </div>

                              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {people.map((person) => (
                                  <label key={person.id} className="rounded-2xl border border-white bg-white p-3">
                                    <div className="mb-1 text-xs font-medium text-slate-600">{person.name}</div>
                                    <Input
                                      type="number"
                                      step="0.1"
                                      min="0"
                                      value={itemAlloc[person.id] ?? 0}
                                      className="h-10"
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

                              <p className="mt-2 text-xs text-slate-500">
                                {assignedTotal > 0
                                  ? `${assignedTotal.toFixed(1)} share${assignedTotal === 1 ? '' : 's'}`
                                  : 'Not assigned'}
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

          {/* Sidebar (split + done: who owes what + allocation progress) */}
          {step === 3 && (
            <aside className="space-y-4">
              <div className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.07)]">
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.22em] text-teal-600">Summary</p>
                    <h3 className="mt-1 text-lg font-semibold text-slate-900">Who owes what</h3>
                  </div>
                  <div className="grid gap-2">
                    {people.map((person) => (
                      <div key={person.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                        <div className="text-sm text-slate-500">{person.name}</div>
                        <div className="mt-1 text-2xl font-semibold text-slate-900">{formatMoney(personTotals[person.id] || 0, currency)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 text-sm text-slate-500">
                    <div className="flex items-center justify-between">
                      <span>Subtotal</span>
                      <span className="text-slate-700">{formatMoney(subtotal, currency)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span>Tip</span>
                      <span className="text-slate-700">{formatMoney(tipAmount, currency)}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 font-semibold text-slate-900">
                      <span>Total</span>
                      <span>{formatMoney(grandTotal, currency)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {step === 3 && (
                <Card className="border-white/70">
                  <CardContent className="space-y-3 p-5">
                    <div className="flex items-center justify-between text-sm text-slate-600">
                      <span>Allocation</span>
                      <span className="font-semibold">{Math.round(completion * 100)}%</span>
                    </div>
                    <div className="h-2.5 rounded-full bg-slate-200">
                      <div className="h-2.5 rounded-full bg-teal-500 transition-all" style={{ width: `${completion * 100}%` }} />
                    </div>
                    <p className="text-xs text-slate-500">
                      {formatMoney(splitAssignedValue, currency)} of {formatMoney(subtotal, currency)} assigned
                    </p>
                  </CardContent>
                </Card>
              )}
            </aside>
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/90 px-4 py-3 backdrop-blur-lg">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-[6rem] rounded-2xl sm:h-12 sm:min-w-[7.5rem]"
            disabled={step === 1}
            onClick={() => setStep((current) => Math.max(1, current - 1) as Step)}
          >
            <ChevronLeft className="mr-1 size-4" /> Back
          </Button>
          {step !== 1 && (
            <div className="text-center">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-400">{currentStep.label}</p>
              <p className="text-sm font-semibold text-slate-900">{currentStep.title}</p>
            </div>
          )}
          <Button
            type="button"
            className="h-11 min-w-[6rem] rounded-2xl sm:h-12 sm:min-w-[7.5rem]"
            disabled={nextDisabled}
            onClick={() => setStep((current) => Math.min(3, current + 1) as Step)}
          >
            Next <ChevronRight className="ml-1 size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default App;
