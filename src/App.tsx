import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader2, Plus, Sparkles } from 'lucide-react';
import Tesseract from 'tesseract.js';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { Input } from './components/ui/input';

type ReceiptItem = { id: string; name: string; price: number; quantity: number };
type Person = { id: string; name: string };

type Corner = { x: number; y: number };

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function parsePrice(raw: string) {
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function parseReceipt(text: string): { items: ReceiptItem[]; total: number } {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const items: ReceiptItem[] = [];
  let total = 0;

  for (const line of lines) {
    const totalMatch = line.match(/(?:^|\s)(total|tot(?:al)?\.?|amount due|montante|a pagar)\s*[:€ ]*([0-9]+[.,][0-9]{2})/i);
    if (totalMatch) {
      const maybeTotal = parsePrice(totalMatch[2]);
      if (!Number.isNaN(maybeTotal)) total = Math.max(total, maybeTotal);
    }

    const qtyLine = line.match(/^([0-9]+(?:[.,][0-9]+)?)\s*[x×]\s+(.+?)\s+([0-9]+[.,][0-9]{2})$/i);
    if (qtyLine) {
      const quantity = parsePrice(qtyLine[1]);
      const name = qtyLine[2].trim();
      const price = parsePrice(qtyLine[3]);
      if (name && !Number.isNaN(quantity) && !Number.isNaN(price)) {
        items.push({ id: uid('item'), name, price, quantity });
      }
      continue;
    }

    const itemMatch = line.match(/^(.+?)\s+([0-9]+[.,][0-9]{2})$/);
    if (!itemMatch) continue;

    const name = itemMatch[1].replace(/\s{2,}/g, ' ').trim();
    const price = parsePrice(itemMatch[2]);
    if (!name || Number.isNaN(price)) continue;
    if (/(total|subtotal|troco|change|iva|vat)/i.test(name)) continue;

    items.push({ id: uid('item'), name, price, quantity: 1 });
  }

  if (!total) total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items: items.slice(0, 60), total };
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
    const v00 = data[i00 + c];
    const v10 = data[i10 + c];
    const v01 = data[i01 + c];
    const v11 = data[i11 + c];
    out[c] =
      v00 * (1 - dx) * (1 - dy) +
      v10 * dx * (1 - dy) +
      v01 * (1 - dx) * dy +
      v11 * dx * dy;
  }
  return out;
}

function preprocessForOcr(inputDataUrl: string) {
  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.max(1.5, 1600 / Math.max(img.width, 1));
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
      const mean = sum / (d.length / 4);
      const threshold = mean * 0.93;

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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [corners, setCorners] = useState<Corner[]>([]);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const [processedDataUrl, setProcessedDataUrl] = useState<string | null>(null);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [people, setPeople] = useState<Person[]>([
    { id: uid('p'), name: 'Person 1' },
    { id: uid('p'), name: 'Person 2' },
  ]);
  const [tipMode, setTipMode] = useState<'percent' | 'fixed'>('percent');
  const [tipValue, setTipValue] = useState(10);
  const [alloc, setAlloc] = useState<Record<string, Record<string, number>>>({});

  const previewRef = useRef<HTMLCanvasElement>(null);

  const subtotal = useMemo(() => items.reduce((s, i) => s + i.price * i.quantity, 0), [items]);
  const tipAmount = tipMode === 'percent' ? subtotal * (tipValue / 100) : tipValue;

  const personTotals = useMemo(() => {
    const result: Record<string, number> = {};
    people.forEach((p) => (result[p.id] = 0));

    for (const item of items) {
      const totalAssigned = people.reduce((s, p) => s + (alloc[item.id]?.[p.id] || 0), 0);
      if (!totalAssigned) continue;
      for (const p of people) {
        const q = alloc[item.id]?.[p.id] || 0;
        result[p.id] += (q / totalAssigned) * item.price * item.quantity;
      }
    }

    const totalWithoutTip = Object.values(result).reduce((a, b) => a + b, 0) || 1;
    for (const p of people) {
      const share = result[p.id] / totalWithoutTip;
      result[p.id] += tipAmount * share;
    }
    return result;
  }, [people, alloc, items, tipAmount]);

  const onFile = (file?: File) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    const img = new Image();
    img.onload = () => {
      setImageEl(img);
      setCorners([
        { x: img.width * 0.1, y: img.height * 0.1 },
        { x: img.width * 0.9, y: img.height * 0.1 },
        { x: img.width * 0.9, y: img.height * 0.9 },
        { x: img.width * 0.1, y: img.height * 0.9 },
      ]);
    };
    img.src = url;
  };

  useEffect(() => {
    if (!imageEl || !previewRef.current) return;
    const canvas = previewRef.current;
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

    const scaled = corners.map((c) => ({ x: c.x * scale, y: c.y * scale }));
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    scaled.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    scaled.forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }, [imageEl, corners, brightness, contrast, saturation]);

  const flattenAndEnhance = () => {
    if (!imageEl || corners.length !== 4) return;

    const width = Math.max(
      400,
      Math.round(
        (Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) +
          Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y)) /
          2,
      ),
    );
    const height = Math.max(
      600,
      Math.round(
        (Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) +
          Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y)) /
          2,
      ),
    );

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

    const url = dstCanvas.toDataURL('image/png');
    setProcessedDataUrl(url);
  };

  const runOcr = async () => {
    if (!processedDataUrl) return;
    setOcrLoading(true);
    try {
      const prepared = await preprocessForOcr(processedDataUrl);
      const result = await Tesseract.recognize(prepared, 'eng');
      const parsed = parseReceipt(result.data.text);
      setItems(
        parsed.items.length
          ? parsed.items
          : [{ id: uid('item'), name: 'Manual item', price: parsed.total || 0, quantity: 1 }],
      );
    } finally {
      setOcrLoading(false);
    }
  };

  const total = Object.values(personTotals).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8 space-y-4">
      <h1 className="text-2xl font-bold">Split 🍕</h1>
      <p className="text-sm text-slate-600">Receipt scanner + smart split MVP (mobile-first)</p>

      <Card><CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <Camera className="size-4" /> Upload receipt photo
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <Button onClick={flattenAndEnhance} disabled={!imageEl}>Flatten image</Button>
          <Button onClick={runOcr} disabled={!processedDataUrl || ocrLoading}>{ocrLoading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Extract text</Button>
        </div>

        {imageUrl && <canvas
          ref={previewRef}
          className="w-full rounded border bg-white touch-none"
          onPointerDown={(e) => {
            if (!imageEl || !previewRef.current) return;
            const rect = previewRef.current.getBoundingClientRect();
            const scale = imageEl.width / previewRef.current.width;
            const x = (e.clientX - rect.left) * scale;
            const y = (e.clientY - rect.top) * scale;
            const nearest = corners.findIndex((c) => Math.hypot(c.x - x, c.y - y) < 45 * scale);
            if (nearest >= 0) {
              setActiveCorner(nearest);
              previewRef.current.setPointerCapture(e.pointerId);
            }
          }}
          onPointerMove={(e) => {
            if (activeCorner === null || !imageEl || !previewRef.current) return;
            const rect = previewRef.current.getBoundingClientRect();
            const scale = imageEl.width / previewRef.current.width;
            const x = clamp((e.clientX - rect.left) * scale, 0, imageEl.width);
            const y = clamp((e.clientY - rect.top) * scale, 0, imageEl.height);
            setCorners((prev) => prev.map((c, i) => (i === activeCorner ? { x, y } : c)));
          }}
          onPointerUp={() => setActiveCorner(null)}
          onPointerCancel={() => setActiveCorner(null)}
          onPointerLeave={() => setActiveCorner(null)}
        />}

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

        {processedDataUrl && <img src={processedDataUrl} alt="Processed receipt" className="max-h-96 rounded border" />}
      </CardContent></Card>

      <Card><CardContent className="space-y-2">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Receipt Items</h2></div>
        {items.map((it) => (
          <div key={it.id} className="grid grid-cols-12 gap-2">
            <Input className="col-span-7" value={it.name} onChange={(e) => setItems((p) => p.map((x) => x.id === it.id ? { ...x, name: e.target.value } : x))} />
            <Input className="col-span-2" type="number" step="0.01" value={it.quantity} onChange={(e) => setItems((p) => p.map((x) => x.id === it.id ? { ...x, quantity: Number(e.target.value || 1) } : x))} />
            <Input className="col-span-3" type="number" step="0.01" value={it.price} onChange={(e) => setItems((p) => p.map((x) => x.id === it.id ? { ...x, price: Number(e.target.value || 0) } : x))} />
          </div>
        ))}
        <Button variant="outline" onClick={() => setItems((p) => [...p, { id: uid('item'), name: 'New item', quantity: 1, price: 0 }])}>Add item</Button>
      </CardContent></Card>

      <Card><CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">People</h2>
          <Button variant="outline" onClick={() => setPeople((p) => [...p, { id: uid('p'), name: `Person ${p.length + 1}` }])}><Plus className="size-4" /> Add person</Button>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {people.map((p) => <Input key={p.id} value={p.name} onChange={(e) => setPeople((prev) => prev.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x))} />)}
        </div>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 overflow-x-auto">
        <h2 className="font-semibold">Allocation table (float quantities allowed)</h2>
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b"><th className="py-2 text-left">Item</th>{people.map((p) => <th key={p.id} className="px-2">{p.name}</th>)}</tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b align-top">
                <td className="py-2 pr-3">{item.name} ({item.quantity} × €{item.price.toFixed(2)})</td>
                {people.map((p) => (
                  <td key={p.id} className="p-1">
                    <Input
                      type="number"
                      step="0.1"
                      value={alloc[item.id]?.[p.id] ?? 0}
                      onChange={(e) => setAlloc((prev) => ({
                        ...prev,
                        [item.id]: { ...(prev[item.id] || {}), [p.id]: Number(e.target.value || 0) },
                      }))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="space-y-3">
        <h2 className="font-semibold">Tip + Summary</h2>
        <div className="flex items-center gap-2">
          <Button variant={tipMode === 'percent' ? 'default' : 'outline'} onClick={() => setTipMode('percent')}>%</Button>
          <Button variant={tipMode === 'fixed' ? 'default' : 'outline'} onClick={() => setTipMode('fixed')}>€</Button>
          <Input className="max-w-40" type="number" step="0.5" value={tipValue} onChange={(e) => setTipValue(Number(e.target.value || 0))} />
        </div>
        <div className="space-y-1 text-sm">
          <div>Subtotal: €{subtotal.toFixed(2)}</div>
          <div>Tip: €{tipAmount.toFixed(2)}</div>
          <div className="font-semibold">Total: €{(subtotal + tipAmount).toFixed(2)}</div>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {people.map((p) => (
            <div key={p.id} className="rounded border p-3 text-sm">
              <div className="font-medium">{p.name}</div>
              <div>€{(personTotals[p.id] || 0).toFixed(2)}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500">Distributed total: €{total.toFixed(2)}</p>
      </CardContent></Card>
    </div>
  );
}

export default App;
