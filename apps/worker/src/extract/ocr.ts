import type { Worker } from "tesseract.js";
import { createWorker } from "tesseract.js";

/**
 * OCR behind an interface, because the choice is going to change. Tesseract
 * is right for now: it runs locally, costs nothing, and needs no model API
 * key — which matters while the spend cap is still unset. A vision model
 * will read messy scans far better, and it slots in here.
 */
export type OcrResult = { text: string; confidence: number };
export interface OcrProvider {
  recognize(png: Buffer): Promise<OcrResult>;
  dispose(): Promise<void>;
}

export class TesseractOcr implements OcrProvider {
  private worker: Worker | null = null;

  /**
   * Loading the language data is expensive (tens of MB, once). Keeping one
   * worker for the life of the process turns that into a startup cost
   * instead of a per-page one.
   */
  private async ready(): Promise<Worker> {
    this.worker ??= await createWorker("eng");
    return this.worker;
  }

  async recognize(png: Buffer): Promise<OcrResult> {
    const worker = await this.ready();
    const { data } = await worker.recognize(png);
    return { text: data.text, confidence: data.confidence };
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

let shared: OcrProvider | null = null;
export function ocr(): OcrProvider {
  shared ??= new TesseractOcr();
  return shared;
}
export async function disposeOcr(): Promise<void> {
  await shared?.dispose();
  shared = null;
}
