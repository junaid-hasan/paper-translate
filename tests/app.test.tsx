import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../src/App';

describe('App scaffold', () => {
  it('shows document-level language control', () => {
    render(<App />);
    expect(screen.getByText('Rosetta Paper')).toBeInTheDocument();
    expect(screen.getByLabelText('Source language')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('User prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Translate Current Page' })).toBeInTheDocument();
    expect(screen.getByLabelText('Page controls')).toBeInTheDocument();
    expect(screen.getByText('Page 1 / 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Show raw')).toBeInTheDocument();
  });
});
