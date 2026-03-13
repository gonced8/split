import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('rounded-xl border border-slate-200 bg-white shadow-sm', props.className)} />;
}

export function CardContent(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('p-4', props.className)} />;
}
