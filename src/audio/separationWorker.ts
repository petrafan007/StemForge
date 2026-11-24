import { separateStereoStemsStft } from './stftSeparator';

interface WorkerRequest {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { left, right, sampleRate } = event.data;
  try {
    const stems = separateStereoStemsStft(left, right, sampleRate, (fraction) => {
      self.postMessage({ type: 'progress', fraction });
    });

    const transferables: Transferable[] = [
      stems.vocals[0].buffer,
      stems.vocals[1].buffer,
      stems.guitar[0].buffer,
      stems.guitar[1].buffer,
      stems.bass[0].buffer,
      stems.bass[1].buffer,
      stems.drums[0].buffer,
      stems.drums[1].buffer,
      stems.keyboards[0].buffer,
      stems.keyboards[1].buffer,
    ];

    self.postMessage({ type: 'done', stems }, { transfer: transferables });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : 'Stem separation worker failed',
    });
  }
};
