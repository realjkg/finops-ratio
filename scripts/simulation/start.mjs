import process from 'node:process';
import { spawn } from 'node:child_process';
const port = process.env.PORT ?? '3000';
if (!/^\d+$/.test(port)) throw new Error('PORT must be numeric.');
if (process.env.RATIO_ENV && !['test', 'development'].includes(process.env.RATIO_ENV)) throw new Error('Simulation cannot run with a production environment.');
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', port, '--hostname', '127.0.0.1'], {
  stdio: 'inherit', env: { ...process.env, RATIO_SIMULATION: '1', RATIO_ENV: 'test', RATIO_SIMULATION_ORIGIN: process.env.RATIO_SIMULATION_ORIGIN ?? `http://localhost:${port}` },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
