// Vitest setup file of the PARALLEL DB config: the runtime backstop against
// dangerous roles (see dangerousLoginBackstop.ts), after every test and after
// the file. Registered first, so with vitest's default stacked hooks its
// beforeAll runs before, and its afterEach/afterAll after, the file's own.
import { afterAll, afterEach, beforeAll } from 'vitest';
import { installDangerousLoginBackstop } from './dangerousLoginBackstop';

installDangerousLoginBackstop({ beforeAll, afterEach, afterAll }, { perTest: true });
