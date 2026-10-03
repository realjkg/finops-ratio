// Vitest setup file of the PARALLEL DB config: the runtime backstop against
// dangerous test logins (see dangerousLoginBackstop.ts). Registered first, so
// with vitest's default stacked hooks its afterAll runs after the file's own.
import { afterAll, afterEach } from 'vitest';
import { installDangerousLoginBackstop } from './dangerousLoginBackstop';

installDangerousLoginBackstop({ afterEach, afterAll });
