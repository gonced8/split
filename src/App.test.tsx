import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App wizard', () => {
  it('starts in step 1 and disables next before processing image', () => {
    render(<App />);
    expect(screen.getAllByText(/Scan receipt/i)[0]).toBeInTheDocument();
    const next = screen.getByRole('button', { name: /next/i });
    expect(next).toBeDisabled();
  });
});
