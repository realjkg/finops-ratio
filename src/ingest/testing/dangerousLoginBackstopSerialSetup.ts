// Vitest setup file of the SERIAL DB config: serial files may create dangerous
// roles on purpose (one file at a time, nothing else running), but must leave
// nothing behind — the backstop (see dangerousLoginBackstop.ts) checks once,
// after the file's own cleanup.
import { afterAll, afterEach, beforeAll } from 'vitest';
import { installDangerousLoginBackstop } from './dangerousLoginBackstop';

installDangerousLoginBackstop({ beforeAll, afterEach, afterAll }, { perTest: false });
