// In-memory, bounded dead-letter store for deliveries that could not be
// completed. A production deployment injects a durable sink instead; this one
// is for tests and single-process use. At capacity the OLDEST record is dropped
// and counted, so the store can never grow without bound.

import type { DeadLetterRecord, DeadLetterSink } from './types';

export const DEFAULT_DEAD_LETTER_CAPACITY = 1000;

export class InMemoryDeadLetters implements DeadLetterSink {
  private readonly records: DeadLetterRecord[] = [];
  private droppedCount = 0;

  constructor(private readonly capacity: number = DEFAULT_DEAD_LETTER_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000) throw new Error('invalid dead-letter capacity');
  }

  put(rec: DeadLetterRecord): void {
    if (this.records.length >= this.capacity) {
      this.records.shift();
      this.droppedCount += 1;
    }
    this.records.push(rec);
  }

  list(): readonly DeadLetterRecord[] {
    return [...this.records];
  }

  /** Records discarded because the store was full. */
  dropped(): number {
    return this.droppedCount;
  }
}
