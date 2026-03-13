import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Loader2, Plus, Sparkles } from 'lucide-react';
import Tesseract from 'tesseract.js';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { Input } from './components/ui/input';
import { computeSplitTotals, type Person } from './lib/split';
import { parseReceipt, type ReceiptItem, uid } from './lib/receipt';

type Corner = { x: number; y: number };
type Step = 1 | 2 | 3;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

async function preprocessForOcr(inputDataUrl: string) {
  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.max(1.7, 1900 / Math.max(img.width, 1));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));

      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const d = imageData.data;

      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += gray;
      }
      const threshold = (sum / (d.length / 4)) * 0.9;

      for (let i = 0; i < d.length; i += 4) {
        const gray = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        const bw = gray > threshold ? 255 : 0;
        d[i] = bw;
        d[i + 1] = bw;
        d[i + 2] = bw;
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to load image for OCR preprocess'));
    img.src = inputDataUrl;
  });
}

function App() {
  const [step, setStep] = useState<Step>(1);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [processedDataUrl, setProcessedDataUrl] = useState<string | null>(null);
  const [corners, setCorners] = useState<Corner[]>([]);
  const [dragCorner, setDragCorner] = useState<number | null>(null);
  const [brightness, setBrightness] = useState(110);
  const [contrast, setContrast] = useState(120);
  const [saturation, setSaturation] = useState(100);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [people, setPeople] = useState<Person[]>([
    { id: uid('p'), name: 'Person 1' },
    { id: uid('p'), name: 'Person 2' },
  ]);
  const [tipMode, setTipMode] = useState<'percent' | 'fixed'>('percent');
  const [tipValue, setTipValue] = useState(10);
  const [alloc, setAlloc] = useState<Record<string, Record<string, number>>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const subtotal = useMemo(() => items.reduce((s, i) => s + i.price * i.quantity, 0), [items]);
  const tipAmount = tipMode === 'percent' ? subtotal * (tipValue / 100) : tipValue;
  const personTotals = useMemo(() => computeSplitTotals(people, items, alloc, tipAmount), [people, items, alloc, tipAmount]);

  const onFile = (file?: File) => {
    if (!file) return;
    setOcrError(null);
    const url = URL.createObjectURL(file);
    setProcessedDataUrl(null);
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
    const maxW = 900;
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
      const scaled = corners.map((c) => ({ x: c.x * scale, y: c.y * scale }));
      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      scaled.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
      ctx.stroke();
    }
  }, [imageEl, corners, brightness, contrast, saturation]);

  const moveCornerFromPointer = (cornerIndex: number, clientX: number, clientY: number) => {
    if (!imageEl || !overlayRef.current || !canvasRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const xOnCanvas = clamp(clientX - rect.left, 0, rect.width);
    const yOnCanvas = clamp(clientY - rect.top, 0, rect.height);
    const scale = imageEl.width / canvasRef.current.width;
    const x = xOnCanvas * scale;
    const y = yOnCanvas * scale;
    setCorners((prev) => prev.map((c, i) => (i === cornerIndex ? { x, y } : c)));
  };

  const flattenAndEnhance = () => {
    if (!imageEl || corners.length !== 4) return;

    const width = Math.max(500, Math.round((Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) + Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y)) / 2));
    const height = Math.max(700, Math.round((Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) + Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y)) / 2));

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = imageEl.width;
    srcCanvas.height = imageEl.height;
    const srcCtx = srcCanvas.getContext('2d')!;
    srcCtx.drawImage(imageEl, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = width;
    dstCanvas.height = height;
    const dstCtx = dstCanvas.getContext('2d')!;

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
      const prepared = await preprocessForOcr(processedDataUrl);
      const firstPass = await Tesseract.recognize(prepared, 'eng+por');
      let parsed = parseReceipt(firstPass.data.text);

      if (!parsed.items.length) {
        const fallbackPass = await Tesseract.recognize(processedDataUrl, 'eng+por');
        const fallbackParsed = parseReceipt(fallbackPass.data.text);
        if (fallbackParsed.items.length) parsed = fallbackParsed;
      }

      if (!parsed.items.length) {
        setOcrError('Could not extract line items from this photo. You can still add items manually.');
      }

      setItems(parsed.items.length ? parsed.items : [{ id: uid('item'), name: 'Manual item', quantity: 1, price: 0 }]);
      setStep(2);
    } catch {
      setOcrError('OCR failed on this image. Try increasing contrast, recropping, and run extract again.');
    } finally {
      setOcrLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-4 space-y-4 pb-16">
      <h1 className="text-2xl font-bold">Split</h1>
      <p className="text-sm text-slate-600">Step {step} of 3</p>

      {step === 1 && (
        <Card><CardContent className="space-y-4">
          <h2 className="font-semibold">1) Receipt photo + crop</h2>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Camera className="size-4" /> Upload receipt photo
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>

          {imageEl && (
            <div className="space-y-2">
              <div ref={overlayRef} className="relative w-full touch-none" style={{ maxWidth: 900 }}>
                <canvas ref={canvasRef} className="w-full rounded border bg-white block" />
                {corners.map((corner, i) => {
                  const leftPct = (corner.x / imageEl.width) * 100;
                  const topPct = (corner.y / imageEl.height) * 100;
                  return (
                    <button
                      key={i}
                      aria-label={`corner-${i + 1}`}
                      className="absolute h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan-500 bg-white shadow"
                      style={{ left: `${leftPct}%`, top: `${topPct}%` }}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setDragCorner(i);
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        if (dragCorner !== i) return;
                        moveCornerFromPointer(i, e.clientX, e.clientY);
                      }}
                      onPointerUp={() => setDragCorner(null)}
                      onPointerCancel={() => setDragCorner(null)}
                    />
                  );
                })}
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {[
                  { label: 'Brightness', value: brightness, setValue: setBrightness },
                  { label: 'Contrast', value: contrast, setValue: setContrast },
                  { label: 'Saturation', value: saturation, setValue: setSaturation },
                ].map(({ label, value, setValue }) => (
                  <label key={label} className="text-sm">
                    {label}: {value}%
                    <input className="w-full" type="range" min={50} max={200} value={value} onChange={(e) => setValue(Number(e.target.value))} />
                  </label>
                ))}
              </div>

              <div className="flex gap-2">
                <Button onClick={flattenAndEnhance}>Flatten image</Button>
                <Button onClick={runOcr} disabled={!processedDataUrl || ocrLoading}>
                  {ocrLoading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Extract text
                </Button>
              </div>
              {ocrError && <p className="text-sm text-red-600">{ocrError}</p>}
              {processedDataUrl && <img src={processedDataUrl} className="max-h-80 rounded border" alt="processed" />}
            </div>
          )}
        </CardContent></Card>
      )}

      {step === 2 && (
        <Card><CardContent className="space-y-3">
          <h2 className="font-semibold">2) Review extracted items</h2>
          {items.map((it) => (
            <div key={it.id} className="grid grid-cols-12 gap-2">
              <Input className="col-span-6" value={it.name} onChange={(e) => setItems((p) => p.map((x) => x.id === it.id ? { ...x, name: e.target.value } : x))} />
              <Input className="col-span-2" type="number" step="0.1" value={it.quantity} onChange={(e) => setItems((p) => p.map((x) => x.id === it.id ? { ...x, quantity: Number(e.target.value || 1) } : x))} />
              <Input className="col-span-3" type="number" step="0.01" value={it.price} onChange={(e) => setItems((p) => p.map((x) => x.id === it.id ? { ...x, price: Number(e.target.value || 0) } : x))} />
              <Button className="col-span-1" variant="ghost" onClick={() => setItems((p) => p.filter((x) => x.id !== it.id))}>✕</Button>
            </div>
          ))}
          <Button variant="outline" onClick={() => setItems((p) => [...p, { id: uid('item'), name: 'New item', quantity: 1, price: 0 }])}>Add item</Button>
        </CardContent></Card>
      )}

      {step === 3 && (
        <>
          <Card><CardContent className="space-y-2">
            <h2 className="font-semibold">3) People + allocation</h2>
            <div className="grid gap-2 md:grid-cols-3">
              {people.map((p) => <Input key={p.id} value={p.name} onChange={(e) => setPeople((prev) => prev.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x))} />)}
            </div>
            <Button variant="outline" onClick={() => setPeople((p) => [...p, { id: uid('p'), name: `Person ${p.length + 1}` }])}><Plus className="size-4" /> Add person</Button>
          </CardContent></Card>

          <Card><CardContent className="space-y-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr className="border-b"><th className="py-2 text-left">Item</th>{people.map((p) => <th key={p.id}>{p.name}</th>)}</tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="py-2">{item.name} ({item.quantity} × €{item.price.toFixed(2)})</td>
                    {people.map((p) => (
                      <td key={p.id} className="p-1">
                        <Input type="number" step="0.1" value={alloc[item.id]?.[p.id] ?? 0} onChange={(e) => setAlloc((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] || {}), [p.id]: Number(e.target.value || 0) } }))} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent></Card>

          <Card><CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Button variant={tipMode === 'percent' ? 'default' : 'outline'} onClick={() => setTipMode('percent')}>%</Button>
              <Button variant={tipMode === 'fixed' ? 'default' : 'outline'} onClick={() => setTipMode('fixed')}>€</Button>
              <Input className="max-w-32" type="number" step="0.5" value={tipValue} onChange={(e) => setTipValue(Number(e.target.value || 0))} />
            </div>
            <p className="text-sm">Subtotal: €{subtotal.toFixed(2)} · Tip: €{tipAmount.toFixed(2)}</p>
            <div className="grid gap-2 md:grid-cols-2">
              {people.map((p) => <div key={p.id} className="rounded border p-2 text-sm"><b>{p.name}</b>: €{(personTotals[p.id] || 0).toFixed(2)}</div>)}
            </div>
          </CardContent></Card>
        </>
      )}

      <div className="fixed bottom-0 left-0 right-0 border-t bg-white p-3">
        <div className="mx-auto flex max-w-3xl justify-between">
          <Button variant="outline" disabled={step === 1} onClick={() => setStep((s) => Math.max(1, s - 1) as Step)}><ChevronLeft className="size-4" /> Back</Button>
          <Button disabled={(step === 1 && !processedDataUrl) || (step === 2 && items.length === 0) || step === 3} onClick={() => setStep((s) => Math.min(3, s + 1) as Step)}>Next <ChevronRight className="size-4" /></Button>
        </div>
      </div>
    </div>
  );
}

export default App;
