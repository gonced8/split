import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App wizard', () => {
  it('starts in step 1 with upload prompt and disabled next', () => {
    render(<App />);
    expect(screen.getByText(/Take a photo or upload a receipt/i)).toBeInTheDocument();
    const next = screen.getByRole('button', { name: /next/i });
    expect(next).toBeDisabled();
  });
});
