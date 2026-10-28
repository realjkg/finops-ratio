// Static tests of the engagement packaging (R12). They parse the files and need
// no Docker daemon. js-yaml is a locked transitive dev dependency (no new dependency).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadWorkerConfig } from '../../src/ingest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const compose = yaml.load(read('infrastructure/engagement/compose.yaml'));
const services = compose.services;
const APP_SERVICES = ['app', 'worker', 'migrator'];
const DIGEST = /@sha256:[0-9a-f]{64}$/;

const stage = (dockerfile, name) => {
  const parts = dockerfile.split(/^(?=FROM )/m);
  return parts.find((s) => new RegExp(`^FROM .* AS ${name}\\s*$`, 'm').test(s.split('\n')[0]));
};

describe('engagement compose', () => {
  it('declares postgres, s3 and the three image-based services', () => {
    expect(Object.keys(services).sort()).toEqual(['app', 'migrator', 'postgres', 's3', 'worker']);
  });

  it('pins every third-party image by digest, equal to the digests the local stack and CI use', () => {
    const local = read('docker-compose.local.yml');
    const ci = read('.github/workflows/ci.yml');
    for (const name of ['postgres', 's3']) {
      const image = services[name].image;
      expect(image, name).toMatch(DIGEST);
      expect(local, name).toContain(image);
      expect(services[name].build, name).toBeUndefined();
    }
    expect(services.postgres.image).toMatch(/^postgres:16@/);
    expect(services.s3.image).toMatch(/^chrislusf\/seaweedfs@/);
    expect(ci).toContain(services.s3.image.split('@')[1]);
    for (const name of APP_SERVICES) {
      expect(services[name].image, name).toMatch(/^ratio-engagement:/);
      expect(services[name].build.target, name).toBe('engagement');
      expect(services[name].build.dockerfile).toBe('infrastructure/simulation/Dockerfile');
    }
  });

  it('never sets a simulation variable anywhere', () => {
    for (const file of ['infrastructure/engagement/compose.yaml', '.env.engagement.example']) {
      expect(read(file), file).not.toMatch(/RATIO_SIMULATION/);
    }
    for (const name of APP_SERVICES) {
      expect(Object.keys(services[name].environment ?? {}).filter((k) => k.startsWith('RATIO_SIMULATION')), name).toEqual([]);
    }
  });

  it('publishes ports on loopback only, and none for the database or object store', () => {
    expect(services.postgres.ports).toBeUndefined();
    expect(services.s3.ports).toBeUndefined();
    expect(services.worker.ports).toBeUndefined();
    expect(services.migrator.ports).toBeUndefined();
    const ports = services.app.ports;
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(String(p), String(p)).toMatch(/^127\.0\.0\.1:/);
  });

  it('runs the app services read-only, non-root, with every capability dropped', () => {
    for (const name of APP_SERVICES) {
      const s = services[name];
      expect(s.read_only, name).toBe(true);
      expect(s.cap_drop, name).toEqual(['ALL']);
      expect(s.cap_add, name).toBeUndefined();
      expect(s.security_opt, name).toContain('no-new-privileges:true');
      expect(s.privileged, name).toBeUndefined();
      expect(s.user ?? 'node', name).not.toMatch(/^(0|root)(:|$)/);
      expect(s.tmpfs, name).toContain('/tmp');
    }
  });

  it('mounts the engagement config and users file read-only and selects engagement mode', () => {
    for (const name of APP_SERVICES) {
      const s = services[name];
      expect(s.environment.RATIO_MODE, name).toBe('engagement');
      expect(s.environment.RATIO_ENGAGEMENT_CONFIG, name).toBe('/config/engagement.json');
      expect(s.volumes.filter((v) => v.includes(':/config/')), name).toHaveLength(2);
      for (const v of s.volumes.filter((v) => v.includes(':/config/'))) expect(v, v).toMatch(/:ro$/);
    }
  });

  it('gives the writable /state volume to the app services only', () => {
    for (const name of APP_SERVICES) expect(services[name].volumes.some((v) => /^state:\/state(:|$)/.test(v)), name).toBe(true);
    expect(Object.keys(compose.volumes)).toEqual(expect.arrayContaining(['state', 'pg-data', 's3-data']));
  });

  it('runs worker and migrator as one-shot profiles, not daemons', () => {
    for (const name of ['worker', 'migrator']) {
      expect(services[name].profiles, name).toEqual(['jobs']);
      expect(services[name].restart, name).toBe('no');
    }
    expect(services.app.profiles).toBeUndefined();
    expect(services.migrator.command.join(' ')).toContain('migrate');
  });

  it('requires secrets from the environment and holds no literal credential', () => {
    const text = read('infrastructure/engagement/compose.yaml');
    expect(text).toMatch(/\$\{RATIO_ENGAGEMENT_PG_SUPERUSER_PASSWORD:\?/);
    expect(text).not.toMatch(/PASSWORD:\s+[^$\s"']/);
    expect(text).not.toMatch(/POSTGRES_HOST_AUTH_METHOD/);
  });

  it('gives no secret variable a default value', () => {
    const text = read('infrastructure/engagement/compose.yaml');
    const withDefault = [...text.matchAll(/\$\{([A-Z0-9_]+):-[^}]*\}/g)].map((m) => m[1]);
    expect(withDefault.filter((n) => /PASSWORD|SECRET|KEY|TOKEN/.test(n))).toEqual([]);
    expect(text).not.toMatch(/\$\{[A-Z0-9_]*(PASSWORD|SECRET|KEY|TOKEN)[A-Z0-9_]*-/);
  });

  it('keeps the database network internal', () => {
    expect(compose.networks.backend.internal).toBe(true);
    expect(services.postgres.networks).toEqual(['backend']);
    expect(services.s3.networks).toEqual(['backend']);
  });

  it('lists in .env.engagement.example exactly the variables the compose file requires', () => {
    const example = read('.env.engagement.example');
    const declared = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const used = [...read('infrastructure/engagement/compose.yaml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual([...new Set(declared)].sort());
    for (const line of example.split('\n').filter((l) => /^[A-Z]/.test(l))) {
      if (/PASSWORD|SECRET|KEY/.test(line.split('=')[0])) expect(line, line).toMatch(/=$/);
    }
  });
});

describe('worker configuration inside the engagement stack', () => {
  const dockerfile = read('infrastructure/simulation/Dockerfile');
  const imageEnv = Object.fromEntries(
    [...stage(dockerfile, 'engagement').matchAll(/^ENV (.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).map((kv) => kv.split(/=(.*)/s).slice(0, 2))),
  );
  const resolve = (v) => String(v).replace(/\$\{([A-Z0-9_]+)(?::[-?][^}]*)?\}/g, 'dummy-value');
  const effective = (name, patch = {}) => ({
    ...imageEnv,
    ...Object.fromEntries(Object.entries(services[name].environment).map(([k, v]) => [k, resolve(v)])),
    ...patch,
  });

  it('accepts the compose worker environment on top of the image environment', () => {
    const cfg = loadWorkerConfig(effective('worker'));
    expect(cfg.sourceS3.endpoint).toBe('http://s3:8333');
    expect(cfg.evidenceS3.endpoint).toBe('http://s3:8333');
  });

  it('would reject the internal http endpoints under RATIO_ENV=production (why the worker runs as staging)', () => {
    expect(imageEnv.RATIO_ENV).toBe('production');
    expect(() => loadWorkerConfig(effective('worker', { RATIO_ENV: 'production' }))).toThrow(/https/);
  });

  it('never gives the worker a development or test environment or a test switch', () => {
    const env = effective('worker');
    expect(['staging', 'production']).toContain(env.RATIO_ENV);
    for (const k of ['RATIO_ALLOW_SYNTHETIC_PROVIDERS', 'RATIO_ALLOW_FAKE_SOURCE', 'RATIO_TEST_PAUSE_AFTER_ROWS', 'RATIO_ALLOW_DOWN_MIGRATIONS']) expect(env[k], k).toBeUndefined();
    expect(env.NODE_ENV).toBe('production');
  });

  it('keeps the app and migrator on production', () => {
    expect(effective('app').RATIO_ENV).toBe('production');
    expect(effective('migrator').RATIO_ENV).toBe('production');
  });
});

describe('engagement Dockerfile target', () => {
  const dockerfile = read('infrastructure/simulation/Dockerfile');

  it('builds the worker CLI in a stage between build and engagement', () => {
    const buildStage = stage(dockerfile, 'engagement-build');
    expect(buildStage).toMatch(/^FROM build AS engagement-build/);
    expect(buildStage).toMatch(/RUN npm run worker:build/);
    expect(buildStage).toMatch(/npm prune --omit=dev/);
    expect(stage(dockerfile, 'engagement')).toMatch(/^FROM engagement-build AS engagement/);
  });

  it('runs production, engagement mode, non-root, with no simulation variable', () => {
    const s = stage(dockerfile, 'engagement');
    expect(s).toMatch(/NODE_ENV=production/);
    expect(s).toMatch(/RATIO_MODE=engagement/);
    expect(s).toMatch(/^USER node$/m);
    expect(s).toMatch(/\/state/);
    expect(s).not.toMatch(/RATIO_SIMULATION|RATIO_ENV=development|RATIO_ENV=test/);
    expect(stage(dockerfile, 'engagement-build')).not.toMatch(/RATIO_SIMULATION/);
  });

  it('leaves the build and simulation stages unchanged', () => {
    expect(stage(dockerfile, 'build')).toContain('RUN npm run build && mkdir -p /app/state && chown node:node /app/state');
    const sim = stage(dockerfile, 'simulation');
    expect(sim).toContain('ENV NODE_ENV=production RATIO_ENV=development RATIO_SIMULATION=1 RATIO_SIMULATION_IMAGE=1 RATIO_SIMULATION_DB=/app/state/customer.sqlite');
    expect(sim).not.toMatch(/worker:build|RATIO_MODE/);
  });
});

describe('engagement docs and smoke prerequisite', () => {
  it('states the known limitations plainly in the README', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Engagement mode'));
    expect(section).toMatch(/### Known limitations/);
    expect(section).toMatch(/file import only/i);
    expect(section).toMatch(/one engagement per instance/i);
    expect(section).toMatch(/FOCUS.*verified.*real exports.*1\.0 only/is);
    expect(section).toMatch(/FOCUS 1\.1 to 1\.4 have synthetic fixtures only/);
    expect(section).toMatch(/### Coming from other rows/);
  });

  it('does not state unbuilt behavior in the present tense (R1/R2/R3/R11 are labeled)', () => {
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('## Engagement mode'), readme.indexOf('## Saved customer workflow simulation'));
    for (const line of section.split('\n')) {
      if (/refuses to start|RATIO_MODE=engagement|src\/engagement\/config\.ts|named users|sign in/i.test(line) && !/^```/.test(line)) {
        expect(line, line).toMatch(/after R[0-9]+|will|once R[0-9]+|R[0-9]+ (is|owns|pending)|not (yet )?(implemented|available)|today/i);
      }
    }
    expect(section).toMatch(/Works today/);
    expect(section).toMatch(/Needs R1/);
    expect(section).toMatch(/restart app/);
    expect(section).not.toMatch(/up -d app\s*;? the container reads/);
    expect(section).toMatch(/directory|inode/i);
    expect(section).toMatch(/ratio-engagement-evidence/);
  });

  it('ships a smoke script that fails, never skips, when its prerequisites are absent', () => {
    const smoke = read('infrastructure/engagement/smoke.mjs');
    expect(smoke).toMatch(/src\/engagement\/config\.ts/);
    expect(smoke).toMatch(/process\.exit\(1\)/);
    expect(smoke).not.toMatch(/\.skip|process\.exit\(0\)[^\n]*prerequisite/i);
  });
});
