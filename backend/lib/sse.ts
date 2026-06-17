import { Response } from 'express';

export function sse(res: Response, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
    (res as unknown as { flush: () => void }).flush();
  }
}
