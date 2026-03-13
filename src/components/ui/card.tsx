import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        'rounded-[30px] border border-slate-200/80 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.07)]',
        props.className,
      )}
    />
  );
}

export function CardContent(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cn('p-5', props.className)} />;
}
