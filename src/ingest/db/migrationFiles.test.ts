import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationError,
  findForbiddenStatement,
  findNonExpandStatement,
  findTransactionControl,
  loadMigrations,
} from './migrationFiles';

const tmpDirs: string[] = [];
function tmpDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratio-migfiles-'));
  tmpDirs.push(dir);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const EXPAND = '-- ratio:phase expand\n';
const CONTRACT = '-- ratio:phase contract\n';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MigrationError);
    return (e as MigrationError).code;
  }
  throw new Error('expected a MigrationError, nothing was thrown');
}

describe('loadMigrations', () => {
  it('orders migrations by version and pairs down files', () => {
    const dir = tmpDir({
      '0002_second.up.sql': EXPAND + 'CREATE TABLE b(x int);',
      '0001_first.up.sql': EXPAND + 'CREATE TABLE a(x int);',
      '0001_first.down.sql': 'DROP TABLE a;',
      '0010_tenth.up.sql': CONTRACT + 'DROP TABLE b;',
    });
    const migs = loadMigrations(dir);
    expect(migs.map((m) => [m.version, m.name, m.phase, m.downSql !== null])).toEqual([
      ['0001', 'first', 'expand', true],
      ['0002', 'second', 'expand', false],
      ['0010', 'tenth', 'contract', false],
    ]);
  });

  it('checksum is sha256 of the raw up-file bytes', () => {
    const body = EXPAND + 'CREATE TABLE a(x int);\r\n-- trailing\n';
    const dir = tmpDir({ '0001_a.up.sql': body });
    const expected = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    expect(loadMigrations(dir)[0].checksum).toBe(expected);
    expect(loadMigrations(dir)[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed filenames', () => {
    for (const bad of ['1_a.up.sql', '0001-a.up.sql', '0001_A.up.sql', '0001_a.sql', '0001_a.up.sql.bak', 'README.md']) {
      expect(codeOf(() => loadMigrations(tmpDir({ [bad]: EXPAND })))).toBe('BAD_FILENAME');
    }
  });

  it('rejects duplicate versions', () => {
    const dir = tmpDir({ '0001_a.up.sql': EXPAND, '0001_b.up.sql': EXPAND });
    expect(codeOf(() => loadMigrations(dir))).toBe('DUPLICATE_VERSION');
  });

  it('rejects a down file without an up file', () => {
    const dir = tmpDir({ '0001_a.up.sql': EXPAND, '0002_b.down.sql': 'SELECT 1;' });
    expect(codeOf(() => loadMigrations(dir))).toBe('ORPHAN_DOWN');
  });

  it('rejects a missing migrations directory', () => {
    expect(codeOf(() => loadMigrations(path.join(os.tmpdir(), 'ratio-does-not-exist-' + Date.now())))).toBe('DIR_MISSING');
  });

  it('rejects an up migration without a ratio:phase header', () => {
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': 'CREATE TABLE a(x int);' })))).toBe('MISSING_PHASE');
    // A header below the first statement does not count.
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': 'CREATE TABLE a(x int);\n-- ratio:phase expand\n' }))),
    ).toBe('MISSING_PHASE');
  });

  it('rejects an invalid or duplicated phase header', () => {
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': '-- ratio:phase sideways\nSELECT 1;' })))).toBe(
      'MISSING_PHASE',
    );
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': '-- ratio:phase expand\n-- ratio:phase contract\nSELECT 1;' }))),
    ).toBe('MISSING_PHASE');
  });

  it('rejects an expand migration containing destructive statements', () => {
    const destructive = [
      'DROP TABLE a;',
      'drop index a_idx;',
      'ALTER TABLE a DROP COLUMN x;',
      'ALTER TABLE a DROP CONSTRAINT a_ck;',
      'ALTER TABLE a RENAME COLUMN x TO y;',
      'ALTER TABLE a RENAME TO b;',
      'ALTER TABLE a ALTER COLUMN x TYPE bigint;',
      'ALTER TABLE a ALTER x TYPE bigint;',
      'TRUNCATE a;',
      'DELETE FROM a;',
    ];
    for (const stmt of destructive) {
      expect(findNonExpandStatement(stmt), stmt).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + stmt })))).toBe('EXPAND_NOT_ADDITIVE');
    }
  });

  it('expand is an allow-list: every challenger bypass is classified non-expand', () => {
    // Each of these slipped through the earlier deny-list classifier.
    const bypasses: Record<string, string> = {
      do_block_execute_drop: "DO $$ BEGIN EXECUTE 'DROP TABLE ratio.cost_facts'; END $$;",
      cte_delete: 'WITH d AS (DELETE FROM ratio.cost_facts RETURNING 1) SELECT count(*) FROM d;',
      update_all: "UPDATE ratio.ingest_batches SET status = 'superseded';",
      insert: 'INSERT INTO ratio.tenants (id, slug) VALUES (gen_random_uuid(), \'x\');',
      no_force_rls: 'ALTER TABLE ratio.cost_facts NO FORCE ROW LEVEL SECURITY;',
      disable_rls: 'ALTER TABLE ratio.cost_facts DISABLE ROW LEVEL SECURITY;',
      alter_policy: 'ALTER POLICY tenant_isolation ON ratio.cost_facts USING (true);',
      create_or_replace_view: 'CREATE OR REPLACE VIEW ratio.cost_facts_published AS SELECT * FROM ratio.cost_facts;',
      create_or_replace_fn: "CREATE OR REPLACE FUNCTION ratio.current_tenant_id() RETURNS uuid LANGUAGE sql AS 'select null::uuid';",
      create_or_replace_other_fn: "CREATE OR REPLACE FUNCTION ratio.f() RETURNS int LANGUAGE sql AS 'select 1';",
      grant_public: 'GRANT SELECT ON ALL TABLES IN SCHEMA ratio TO PUBLIC;',
      revoke_from_role: 'REVOKE SELECT ON ratio.cost_facts_published FROM ratio_reader;',
      alter_role_bypass: 'ALTER ROLE ratio_worker BYPASSRLS;',
      set_not_null: 'ALTER TABLE ratio.cost_facts ALTER COLUMN provider_name SET NOT NULL;',
      add_constraint_validated: 'ALTER TABLE ratio.cost_facts ADD CONSTRAINT c CHECK (billed_cost > 0);',
      add_column_then_drop: 'ALTER TABLE ratio.cost_facts ADD COLUMN x int, DROP COLUMN provider_name;',
      call_proc: 'CALL some_proc_that_commits();',
      session_set_role: 'SET ROLE ratio_owner;',
      session_search_path: 'SET search_path = evil, pg_catalog;',
      select_side_effect: 'SELECT pg_catalog.pg_terminate_backend(1);',
      select_from_table: 'SELECT * FROM ratio.cost_facts;',
      membership_grant: 'GRANT ratio_owner TO ratio_worker;',
      alter_type_using: 'ALTER TABLE ratio.cost_facts ALTER billed_cost TYPE float8 USING billed_cost::float8;',
      disable_trigger: 'ALTER TABLE ratio.cost_facts DISABLE TRIGGER ALL;',
      comment_prefixed_drop: '/* x */ DROP TABLE ratio.cost_facts;',
    };
    for (const [name, sql] of Object.entries(bypasses)) {
      expect(findNonExpandStatement(sql), name).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + sql }))), name).toMatch(
        /^(EXPAND_NOT_ADDITIVE|FORBIDDEN_STATEMENT)$/,
      );
    }
  });

  it('always refuses RLS/policy/PUBLIC/role-escalation statements, even in a contract migration', () => {
    const forbidden = [
      'ALTER TABLE ratio.cost_facts DISABLE ROW LEVEL SECURITY;',
      'alter table only ratio.cost_facts no force row level security;',
      'DROP POLICY tenant_isolation ON ratio.cost_facts;',
      'ALTER POLICY tenant_isolation ON ratio.cost_facts USING (true);',
      'GRANT SELECT ON ratio.cost_facts TO PUBLIC;',
      'GRANT SELECT ON ratio.cost_facts TO ratio_reader, public;',
      'ALTER ROLE ratio_worker BYPASSRLS;',
      'ALTER USER ratio_worker SUPERUSER;',
      'ALTER ROLE ratio_reader WITH CREATEROLE;',
      'CREATE ROLE evil SUPERUSER;',
      "CREATE OR REPLACE FUNCTION ratio.current_tenant_id() RETURNS uuid LANGUAGE sql AS 'select null::uuid';",
      'ALTER FUNCTION ratio.current_tenant_id() OWNER TO postgres;',
      'ALTER TABLE ratio.cost_facts DISABLE TRIGGER ALL;',
      "SET session_replication_role = 'replica';",
      "SET LOCAL session_replication_role = 'replica';",
    ];
    for (const sql of forbidden) {
      expect(findForbiddenStatement(sql), sql).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': CONTRACT + sql }))), sql).toBe('FORBIDDEN_STATEMENT');
    }
    // NOSUPERUSER / NOBYPASSRLS are de-escalations and are not forbidden.
    expect(findForbiddenStatement('ALTER ROLE ratio_worker NOSUPERUSER NOBYPASSRLS NOCREATEROLE;')).toBeNull();
  });

  it('a DO block is expand only with a reasoned ratio:allow-do marker on the preceding line', () => {
    const body = "DO $$ BEGIN RAISE NOTICE 'x'; END $$;";
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + body })))).toBe('EXPAND_NOT_ADDITIVE');
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + '-- ratio:allow-do\n' + body })))).toBe(
      'EXPAND_NOT_ADDITIVE',
    );
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + '-- ratio:allow-do role guard\n\nSELECT 1;\n' + body }))),
    ).toBe('EXPAND_NOT_ADDITIVE');
    const ok = loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + '-- ratio:allow-do creates roles idempotently\n' + body }));
    expect(ok[0].phase).toBe('expand');
  });

  it('allows the additive vocabulary in expand and destructive statements in a contract migration', () => {
    expect(loadMigrations(tmpDir({ '0001_a.up.sql': CONTRACT + 'DROP TABLE a;' }))[0].phase).toBe('contract');
    const additive =
      EXPAND +
      "-- DROP TABLE a;\nCREATE TABLE a(x int, note text DEFAULT 'drop table x');\n" +
      '-- ratio:allow-function trigger function for a (round 4: functions in ANY schema need the marker)\n' +
      'CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM a; END $$;\n' +
      'ALTER TABLE a ADD COLUMN y numeric(10,2) NOT NULL DEFAULT 0;\nCOMMENT ON TABLE a IS \'rename me\';\n' +
      'ALTER TABLE a ADD CONSTRAINT a_y CHECK (y >= 0) NOT VALID;\nALTER TABLE a VALIDATE CONSTRAINT a_y;\n' +
      'ALTER TABLE a ENABLE ROW LEVEL SECURITY;\nALTER TABLE a FORCE ROW LEVEL SECURITY;\n' +
      'CREATE UNIQUE INDEX a_x ON a (x);\nCREATE SCHEMA s;\nCREATE SEQUENCE s.q;\nCREATE TYPE s.t AS (a int);\n' +
      '-- ratio:allow-view projection of a (round 4: views in ANY schema need the marker)\n' +
      'CREATE VIEW v AS SELECT x FROM a;\nCREATE POLICY p ON a USING (tenant_id = ratio.current_tenant_id());\n' +
      'CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();\n' +
      'CREATE CONSTRAINT TRIGGER ct AFTER INSERT ON a DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();\n' +
      'GRANT SELECT ON a TO ratio_worker;\nGRANT USAGE ON SCHEMA s TO ratio_worker;\n' +
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA s FROM PUBLIC;\n' +
      'SET LOCAL ROLE ratio_owner;\nSET LOCAL search_path = pg_catalog;\nSELECT pg_catalog.pg_has_role(\'a\', \'b\', \'MEMBER\');\n';
    expect(findNonExpandStatement(additive)).toBeNull();
    expect(findForbiddenStatement(additive)).toBeNull();
    expect(loadMigrations(tmpDir({ '0001_a.up.sql': additive }))[0].phase).toBe('expand');
  });

  it('round 3: policy, reader-grant, view, DO-body, NOT NULL column and function/trigger bypasses are caught (challenger round 2)', () => {
    const forbidden: Record<string, string> = {
      create_policy_true: 'CREATE POLICY open_all ON ratio.cost_facts USING (true) WITH CHECK (true);',
      create_policy_reader_true: 'CREATE POLICY r ON ratio.cost_facts FOR SELECT TO ratio_reader USING (true);',
      create_policy_or_true: 'CREATE POLICY p ON ratio.cost_facts USING (tenant_id = ratio.current_tenant_id() OR true);',
      create_policy_check_open: 'CREATE POLICY p ON ratio.cost_facts USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (true);',
      create_policy_no_clause: 'CREATE POLICY p ON ratio.cost_facts FOR INSERT;',
      grant_reader_base: 'GRANT SELECT ON ratio.cost_facts, ratio.ingest_validation_errors TO ratio_reader;',
      grant_reader_all_tables: 'GRANT SELECT ON ALL TABLES IN SCHEMA ratio TO ratio_reader;',
      grant_reader_quoted: 'GRANT SELECT ON ratio.cost_facts TO "ratio_reader";',
      grant_reader_other_fn: 'GRANT EXECUTE ON FUNCTION ratio.text_looks_secret(text) TO ratio_reader;',
      grant_reader_view_update: 'GRANT UPDATE ON ratio.cost_facts_published TO ratio_reader;',
      grant_pg_read_all: 'GRANT pg_read_all_data TO ratio_reader;',
      grant_member_worker: 'GRANT ratio_owner TO ratio_worker;',
      default_privs_reader: 'ALTER DEFAULT PRIVILEGES IN SCHEMA ratio GRANT SELECT ON TABLES TO ratio_reader;',
      do_body_no_force: "-- ratio:allow-do harmless\nDO $$ BEGIN EXECUTE 'ALTER TABLE ratio.cost_facts NO FORCE ROW LEVEL SECURITY'; END $$;",
      do_body_format_disable: "-- ratio:allow-do harmless\nDO $$ BEGIN EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', 'ratio', 'cost_facts'); END $$;",
      do_body_direct_policy: '-- ratio:allow-do harmless\nDO $$ BEGIN DROP POLICY tenant_isolation ON ratio.cost_facts; END $$;',
      do_body_grant_public: "-- ratio:allow-do harmless\nDO $b$ BEGIN EXECUTE 'GRANT SELECT ON ratio.cost_facts TO PUBLIC'; END $b$;",
      fn_body_bypass:
        "-- ratio:allow-function harmless\nCREATE FUNCTION ratio.f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'ALTER ROLE ratio_worker BYPASSRLS'; END $f$;",
    };
    for (const [name, sql] of Object.entries(forbidden)) {
      expect(findForbiddenStatement(sql), name).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': CONTRACT + sql }))), name).toBe('FORBIDDEN_STATEMENT');
    }
    const nonExpand: Record<string, string> = {
      create_leak_view: 'CREATE VIEW ratio.all_facts AS SELECT * FROM ratio.cost_facts;',
      create_leak_view_quoted: 'CREATE VIEW "ratio"."all_facts" AS SELECT 1;',
      add_col_not_null: 'ALTER TABLE ratio.cost_facts ADD COLUMN x int NOT NULL;',
      create_ratio_fn_unmarked: "CREATE FUNCTION ratio.f() RETURNS int LANGUAGE sql AS 'select 1';",
      create_destructive_trigger_unmarked:
        'CREATE FUNCTION ratio.f() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM ratio.cost_facts; RETURN NULL; END $f$;\n' +
        'CREATE TRIGGER t AFTER INSERT ON ratio.sync_runs FOR EACH STATEMENT EXECUTE FUNCTION ratio.f();',
      create_trigger_on_ratio_unmarked: 'CREATE TRIGGER t AFTER INSERT ON ratio.sync_runs FOR EACH ROW EXECUTE FUNCTION public.f();',
      create_constraint_trigger_unmarked:
        'CREATE CONSTRAINT TRIGGER t AFTER INSERT ON ratio.sync_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.f();',
      marker_wrong_kind: "-- ratio:allow-view reason\nCREATE FUNCTION ratio.f() RETURNS int LANGUAGE sql AS 'select 1';",
      marker_without_reason: '-- ratio:allow-view\nCREATE VIEW ratio.v AS SELECT 1;',
    };
    for (const [name, sql] of Object.entries(nonExpand)) {
      expect(findNonExpandStatement(sql), name).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + sql }))), name).toBe('EXPAND_NOT_ADDITIVE');
    }
    // A ratio view is fine as a contract migration (reviewed explicitly) ...
    expect(loadMigrations(tmpDir({ '0001_a.up.sql': CONTRACT + 'CREATE VIEW ratio.v AS SELECT 1;' }))[0].phase).toBe('contract');
  });

  it('round 3: the reasoned markers make ratio views, functions and triggers expand; legitimate forms still pass', () => {
    const ok =
      EXPAND +
      '-- ratio:allow-view the published read path\nCREATE VIEW ratio.v WITH (security_barrier = true) AS SELECT 1;\n' +
      "-- ratio:allow-function tenant helper\nCREATE FUNCTION ratio.f() RETURNS int LANGUAGE sql AS 'select 1';\n" +
      '-- ratio:allow-function lifecycle guard\nCREATE TRIGGER t BEFORE INSERT ON ratio.sync_runs FOR EACH ROW EXECUTE FUNCTION ratio.f();\n' +
      '-- ratio:allow-function deferred check\n\nCREATE CONSTRAINT TRIGGER ct AFTER INSERT ON ratio.sync_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ratio.f();\n' +
      'CREATE POLICY tenant_isolation ON ratio.t USING (tenant_id = ratio.current_tenant_id()) WITH CHECK (tenant_id = ratio.current_tenant_id());\n' +
      'CREATE POLICY tenants_isolation ON ratio.tenants USING (id = ratio.current_tenant_id());\n' +
      'CREATE POLICY narrow ON ratio.t AS RESTRICTIVE FOR SELECT USING (false);\n' +
      'GRANT USAGE ON SCHEMA ratio TO ratio_worker, ratio_reader;\n' +
      'GRANT SELECT ON ratio.cost_facts_published TO ratio_reader;\n' +
      'GRANT EXECUTE ON FUNCTION ratio.current_tenant_id() TO ratio_worker, ratio_reader;\n' +
      'GRANT SELECT, INSERT ON ratio.cost_facts TO ratio_worker;\n' +
      'ALTER TABLE ratio.t ADD COLUMN y int NOT NULL DEFAULT 0;\nALTER TABLE ratio.t ADD COLUMN z int;\nALTER TABLE ratio.t ADD COLUMN w int DEFAULT 1 NOT NULL;\n' +
      "-- ratio:allow-do creates roles\nDO $r$ BEGIN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE', 'x'); END $r$;\n";
    expect(findForbiddenStatement(ok)).toBeNull();
    expect(findNonExpandStatement(ok)).toBeNull();
    expect(loadMigrations(tmpDir({ '0001_a.up.sql': ok }))[0].phase).toBe('expand');
  });

  it('round 4 (challenger round 3, M1): functions, procedures and views in ANY schema need a marker; SECURITY DEFINER needs its own', () => {
    // The challenger repro: an unmarked expand migration that handed every login cross-tenant reads.
    const repro =
      'CREATE FUNCTION public.report_rows() RETURNS SETOF ratio.cost_facts LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT * FROM ratio.cost_facts $$;';
    expect(findForbiddenStatement(repro)).not.toBeNull();
    expect(findNonExpandStatement(repro)).not.toBeNull();
    expect(codeOf(() => loadMigrations(tmpDir({ '0002_report_helper.up.sql': EXPAND + '-- 0002: reporting helper\n' + repro })))).toMatch(
      /^(EXPAND_NOT_ADDITIVE|FORBIDDEN_STATEMENT)$/,
    );

    // Unmarked function / procedure / view in a schema other than ratio: not expand.
    const nonExpand: Record<string, string> = {
      public_fn: "CREATE FUNCTION public.f() RETURNS bigint LANGUAGE sql STABLE AS 'select count(*) from ratio.cost_facts';",
      quoted_public_fn: 'CREATE FUNCTION "public"."f"() RETURNS int LANGUAGE sql AS $$ select 1 $$;',
      unqualified_fn: "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1';",
      other_schema_fn: "CREATE FUNCTION reporting.f() RETURNS int LANGUAGE sql AS 'select 1';",
      procedure: 'CREATE PROCEDURE public.p() LANGUAGE sql AS $$ SELECT 1 $$;',
      ratio_procedure: 'CREATE PROCEDURE ratio.p() LANGUAGE sql AS $$ SELECT 1 $$;',
      public_view: 'CREATE VIEW public.all_facts AS SELECT * FROM ratio.cost_facts;',
      unqualified_view: 'CREATE VIEW all_facts AS SELECT * FROM ratio.cost_facts;',
      view_with_options: 'CREATE VIEW public.v WITH (security_barrier = true) AS SELECT 1;',
      recursive_view: 'CREATE RECURSIVE VIEW public.r (n) AS SELECT 1;',
      materialized_view: 'CREATE MATERIALIZED VIEW public.mv AS SELECT * FROM ratio.cost_facts;',
      ratio_materialized_view: 'CREATE MATERIALIZED VIEW ratio.mv AS SELECT * FROM ratio.cost_facts;',
      or_replace_public_fn: "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'select 1';",
      or_replace_public_view: 'CREATE OR REPLACE VIEW public.v AS SELECT 1;',
      marker_wrong_kind_public: "-- ratio:allow-view reason\nCREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'select 1';",
    };
    for (const [name, sql] of Object.entries(nonExpand)) {
      expect(findNonExpandStatement(sql), name).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0002_a.up.sql': EXPAND + sql }))), name).toBe('EXPAND_NOT_ADDITIVE');
    }

    // SECURITY DEFINER anywhere, without its own reasoned marker: refused in ANY migration.
    const fnMarker = '-- ratio:allow-function reporting helper\n';
    const forbidden: Record<string, string> = {
      repro_with_function_marker: fnMarker + repro,
      ratio_secdef: fnMarker + "CREATE FUNCTION ratio.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1';",
      lower_case: fnMarker + "create function public.f() returns int language sql security   definer as 'select 1';",
      external_secdef: fnMarker + "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql EXTERNAL SECURITY DEFINER AS 'select 1';",
      procedure_secdef: fnMarker + 'CREATE PROCEDURE public.p() LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
      or_replace_secdef: "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'select 1';",
      alter_function_secdef: 'ALTER FUNCTION public.f() SECURITY DEFINER;',
      alter_routine_secdef: 'ALTER ROUTINE ratio.text_looks_secret(text) SECURITY DEFINER;',
      do_body_secdef:
        "-- ratio:allow-do harmless\nDO $$ BEGIN EXECUTE 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS ''select 1'''; END $$;",
      do_body_alter_secdef: "-- ratio:allow-do harmless\nDO $$ BEGIN ALTER FUNCTION public.f() SECURITY DEFINER; END $$;",
      marker_without_reason: '-- ratio:allow-security-definer\n' + fnMarker + repro,
    };
    for (const [name, sql] of Object.entries(forbidden)) {
      expect(findForbiddenStatement(sql), name).not.toBeNull();
      expect(codeOf(() => loadMigrations(tmpDir({ '0002_a.up.sql': CONTRACT + sql }))), name).toBe('FORBIDDEN_STATEMENT');
      expect(codeOf(() => loadMigrations(tmpDir({ '0002_a.up.sql': EXPAND + sql }))), name).toMatch(/^(EXPAND_NOT_ADDITIVE|FORBIDDEN_STATEMENT)$/);
    }
    // SECURITY INVOKER (the default) is not SECURITY DEFINER.
    expect(findForbiddenStatement("CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY INVOKER AS 'select 1';")).toBeNull();
  });

  it('round 4: marked functions, procedures and views in any schema are expand; a marked SECURITY DEFINER passes the classifier (the runner catalog check is the backstop)', () => {
    const ok =
      EXPAND +
      "-- ratio:allow-function reporting helper\nCREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS 'select 1';\n" +
      "-- ratio:allow-function helper\nCREATE FUNCTION f2() RETURNS int LANGUAGE sql AS 'select 1';\n" +
      '-- ratio:allow-function maintenance\nCREATE PROCEDURE ratio.p() LANGUAGE sql AS $$ SELECT 1 $$;\n' +
      '-- ratio:allow-view projection\nCREATE VIEW public.v AS SELECT 1;\n' +
      '-- ratio:allow-view snapshot\nCREATE MATERIALIZED VIEW ratio.mv AS SELECT 1 AS x;\n' +
      // round 16 M1: a PUBLIC revoke is expand only on objects this file created
      // (was `ALL FUNCTIONS IN SCHEMA public`, which also hits pre-existing functions: now contract).
      'REVOKE EXECUTE ON FUNCTION public.f(), f2() FROM PUBLIC;\nREVOKE EXECUTE ON PROCEDURE ratio.p() FROM PUBLIC;\n';
    expect(findForbiddenStatement(ok)).toBeNull();
    expect(findNonExpandStatement(ok)).toBeNull();
    expect(loadMigrations(tmpDir({ '0002_a.up.sql': ok }))[0].phase).toBe('expand');

    const secdef =
      EXPAND +
      '-- ratio:allow-function reviewed definer helper\n' +
      '-- ratio:allow-security-definer reviewed: reads only the caller tenant\n' +
      "CREATE FUNCTION ratio.f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'select 1';\n";
    expect(findForbiddenStatement(secdef)).toBeNull();
    expect(findNonExpandStatement(secdef)).toBeNull();
    expect(loadMigrations(tmpDir({ '0002_a.up.sql': secdef }))[0].phase).toBe('expand');
    // Order of the two markers in the comment block does not matter.
    const swapped = secdef.replace(
      '-- ratio:allow-function reviewed definer helper\n-- ratio:allow-security-definer reviewed: reads only the caller tenant\n',
      '-- ratio:allow-security-definer reviewed: reads only the caller tenant\n-- ratio:allow-function reviewed definer helper\n',
    );
    expect(swapped).not.toBe(secdef);
    expect(loadMigrations(tmpDir({ '0002_a.up.sql': swapped }))[0].phase).toBe('expand');
  });

  it('records a checksum for the down file too', () => {
    const dir = tmpDir({ '0001_a.up.sql': EXPAND + 'CREATE TABLE a(x int);', '0001_a.down.sql': 'DROP TABLE a;' });
    const [m] = loadMigrations(dir);
    expect(m.downChecksum).toBe(crypto.createHash('sha256').update('DROP TABLE a;').digest('hex'));
    const noDown = loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + 'CREATE TABLE a(x int);' }));
    expect(noDown[0].downChecksum).toBeNull();
  });

  it('rejects migration files containing transaction control', () => {
    expect(codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + 'BEGIN;\nCREATE TABLE a(x int);\nCOMMIT;' })))).toBe(
      'TRANSACTION_CONTROL',
    );
    expect(
      codeOf(() => loadMigrations(tmpDir({ '0001_a.up.sql': EXPAND + 'SELECT 1;', '0001_a.down.sql': 'COMMIT;' }))),
    ).toBe('TRANSACTION_CONTROL');
  });

  it('the shipped migrations directory loads cleanly and 0001 is expand', () => {
    const migs = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(migs.length).toBeGreaterThanOrEqual(1);
    expect(migs[0].version).toBe('0001');
    expect(migs[0].phase).toBe('expand');
    expect(migs[0].downSql).not.toBeNull();
  });
});

describe('findTransactionControl', () => {
  it('detects transaction-control statements', () => {
    const bad: Array<[string, string]> = [
      ['BEGIN;', 'BEGIN'],
      ['create table a(); commit;', 'COMMIT'],
      ['start transaction;', 'START'],
      ['SAVEPOINT s1;', 'SAVEPOINT'],
      ['RELEASE SAVEPOINT s1;', 'RELEASE'],
      ['ROLLBACK;', 'ROLLBACK'],
      ['END;', 'END'],
      ['ABORT;', 'ABORT'],
      ["PREPARE TRANSACTION 'x';", 'PREPARE'],
      ['SELECT 1;\n  begin\n;', 'BEGIN'],
    ];
    for (const [sql, kw] of bad) expect(findTransactionControl(sql), sql).toBe(kw);
  });

  it('ignores transaction keywords inside dollar quotes, comments, strings and identifiers', () => {
    const ok = [
      'DO $$ BEGIN RAISE NOTICE \'x\'; END $$;',
      'DO $body$\nBEGIN\n  PERFORM 1;\nEND\n$body$;',
      '-- BEGIN;\nSELECT 1;',
      '/* COMMIT; /* nested */ ROLLBACK; */ SELECT 1;',
      "SELECT 'BEGIN; COMMIT;';",
      "SELECT E'it\\'s; COMMIT;';",
      'SELECT "begin" FROM t;',
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $fn$ SELECT 1; $fn$;',
      'PREPARE q AS SELECT $1::int;',
    ];
    for (const sql of ok) expect(findTransactionControl(sql), sql).toBeNull();
  });
});

describe('round 16 M1: a REVOKE … FROM PUBLIC is expand only for objects created earlier in the same file', () => {
  const contract = [
    // the reported case: can stop the previous release's logins from reconnecting
    'REVOKE CONNECT ON DATABASE ratio_prod FROM PUBLIC;',
    'REVOKE TEMPORARY ON DATABASE ratio_prod FROM PUBLIC;',
    // pre-existing ratio objects (0001's), not created in this file
    'REVOKE ALL ON SCHEMA ratio FROM PUBLIC;',
    'REVOKE SELECT ON ratio.cost_facts_published FROM PUBLIC;',
    'REVOKE SELECT ON TABLE ratio.cost_facts FROM PUBLIC;',
    'REVOKE EXECUTE ON FUNCTION ratio.current_tenant_id() FROM PUBLIC;',
    'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ratio FROM PUBLIC;',
    // system objects
    'REVOKE EXECUTE ON FUNCTION pg_catalog.now() FROM PUBLIC;',
    'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;',
    'REVOKE USAGE ON SCHEMA public FROM PUBLIC;',
    'REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;',
    'REVOKE USAGE ON TYPE public.money_kind FROM PUBLIC;',
    'REVOKE SET ON PARAMETER work_mem FROM PUBLIC;',
    'REVOKE SELECT ON LARGE OBJECT 4242 FROM PUBLIC;',
  ];
  for (const stmt of contract) {
    it(`is contract: ${stmt}`, () => {
      expect(findNonExpandStatement(EXPAND + stmt)).toBe(stmt.slice(0, -1).toUpperCase());
      expect(codeOf(() => loadMigrations(tmpDir({ '0002_a.up.sql': EXPAND + stmt })))).toBe('EXPAND_NOT_ADDITIVE');
      expect(loadMigrations(tmpDir({ '0002_a.up.sql': CONTRACT + stmt }))[0].phase).toBe('contract');
    });
  }

  it('a revoke that names a created object AND a pre-existing one is contract', () => {
    const sql = EXPAND + 'CREATE TABLE ratio.t1 (x int);\nREVOKE ALL ON ratio.t1, ratio.cost_facts FROM PUBLIC;\n';
    expect(findNonExpandStatement(sql)).toBe('REVOKE ALL ON RATIO.T1, RATIO.COST_FACTS FROM PUBLIC');
  });

  it('a revoke BEFORE the object is created, or on an object created with IF NOT EXISTS / OR REPLACE, is contract', () => {
    expect(findNonExpandStatement(EXPAND + 'REVOKE ALL ON SCHEMA s FROM PUBLIC;\nCREATE SCHEMA s;\n')).toBe('REVOKE ALL ON SCHEMA S FROM PUBLIC');
    expect(findNonExpandStatement(EXPAND + 'CREATE SCHEMA IF NOT EXISTS s;\nREVOKE ALL ON SCHEMA s FROM PUBLIC;\n')).toBe(
      'REVOKE ALL ON SCHEMA S FROM PUBLIC',
    );
    expect(findNonExpandStatement(EXPAND + 'CREATE TABLE IF NOT EXISTS ratio.t1 (x int);\nREVOKE ALL ON ratio.t1 FROM PUBLIC;\n')).toBe(
      'REVOKE ALL ON RATIO.T1 FROM PUBLIC',
    );
  });

  it('a function revoke must match the created signature (an overload that pre-exists is contract)', () => {
    const created = EXPAND + "-- ratio:allow-function helper\nCREATE FUNCTION ratio.add_one(x int) RETURNS int LANGUAGE sql AS 'select x + 1';\n";
    expect(findNonExpandStatement(created + 'REVOKE EXECUTE ON FUNCTION ratio.add_one(int) FROM PUBLIC;\n')).toBeNull();
    expect(findNonExpandStatement(created + 'REVOKE EXECUTE ON FUNCTION ratio.add_one(text) FROM PUBLIC;\n')).toBe(
      'REVOKE EXECUTE ON FUNCTION RATIO.ADD_ONE(TEXT) FROM PUBLIC',
    );
  });

  it('revokes on objects created earlier in the same file stay expand (schema, ALL … IN SCHEMA of a new schema, table, column, view, sequence, type, function)', () => {
    const sql =
      EXPAND +
      'CREATE SCHEMA s;\nREVOKE ALL ON SCHEMA s FROM PUBLIC;\n' +
      'CREATE TABLE s.t (a int, b text);\nREVOKE ALL ON s.t FROM PUBLIC;\nREVOKE SELECT (a) ON TABLE s.t FROM PUBLIC;\n' +
      'CREATE SEQUENCE s.q;\nREVOKE ALL ON SEQUENCE s.q FROM PUBLIC;\n' +
      'CREATE TYPE s.e AS ENUM (\'x\');\nREVOKE USAGE ON TYPE s.e FROM PUBLIC;\n' +
      "-- ratio:allow-function helper\nCREATE FUNCTION s.f(a int, OUT b int, VARIADIC c text[]) LANGUAGE sql AS 'select 1';\n" +
      'REVOKE EXECUTE ON FUNCTION s.f(int, text[]) FROM PUBLIC;\n' +
      '-- ratio:allow-view projection\nCREATE VIEW s.v AS SELECT a FROM s.t;\nREVOKE ALL ON s.v FROM PUBLIC;\n' +
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA s FROM PUBLIC;\nREVOKE ALL ON ALL TABLES IN SCHEMA s FROM PUBLIC CASCADE;\n';
    expect(findNonExpandStatement(sql)).toBeNull();
    expect(loadMigrations(tmpDir({ '0002_a.up.sql': sql }))[0].phase).toBe('expand');
  });

  it('0001 is unchanged and still expand-safe (its revokes are on its own new schema and functions)', () => {
    const up = fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '0001_ratio_schema.up.sql'), 'utf8');
    expect(up).toMatch(/^REVOKE ALL ON SCHEMA ratio FROM PUBLIC;$/m);
    expect(up).toMatch(/^REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ratio FROM PUBLIC;$/m);
    expect(findNonExpandStatement(up)).toBeNull();
    expect(loadMigrations(DEFAULT_MIGRATIONS_DIR)[0].phase).toBe('expand');
  });
});

describe('round 17 (challenger L3): quoted identifiers are case-sensitive, unquoted ones fold to lower case', () => {
  const t = (create: string, revoke: string) => EXPAND + create + '\n' + revoke + '\n';
  const contract: Array<[string, string]> = [
    ['CREATE TABLE ratio."t1" (x int);', 'REVOKE ALL ON ratio."T1" FROM PUBLIC;'],
    ['CREATE TABLE ratio."T1" (x int);', 'REVOKE ALL ON ratio."t1" FROM PUBLIC;'],
    ['CREATE TABLE ratio."T1" (x int);', 'REVOKE ALL ON ratio.T1 FROM PUBLIC;'], // T1 folds to t1
    ['CREATE TABLE ratio.T1 (x int);', 'REVOKE ALL ON ratio."T1" FROM PUBLIC;'],
    ['CREATE SCHEMA "S";', 'REVOKE ALL ON SCHEMA s FROM PUBLIC;'],
    ['CREATE SCHEMA s;', 'REVOKE ALL ON SCHEMA "S" FROM PUBLIC;'],
    ['CREATE TYPE ratio."E" AS ENUM (\'a\');', 'REVOKE USAGE ON TYPE ratio.e FROM PUBLIC;'],
    ["-- ratio:allow-function helper\nCREATE FUNCTION ratio.\"F\"() RETURNS int LANGUAGE sql AS 'select 1';", 'REVOKE EXECUTE ON FUNCTION ratio.f() FROM PUBLIC;'],
    ["-- ratio:allow-function helper\nCREATE FUNCTION ratio.f() RETURNS int LANGUAGE sql AS 'select 1';", 'REVOKE EXECUTE ON FUNCTION ratio."F"() FROM PUBLIC;'],
  ];
  for (const [create, revoke] of contract) {
    it(`contract: ${create.split('\n').pop()} then ${revoke}`, () => {
      expect(findNonExpandStatement(t(create, revoke))).not.toBeNull();
    });
  }
  const expand: Array<[string, string]> = [
    ['CREATE TABLE ratio."T1" (x int);', 'REVOKE ALL ON ratio."T1" FROM PUBLIC;'],
    ['CREATE TABLE ratio."t1" (x int);', 'REVOKE ALL ON RATIO.T1 FROM PUBLIC;'],
    ['CREATE TABLE ratio.T1 (x int);', 'REVOKE ALL ON "ratio"."t1" FROM PUBLIC;'],
    ['CREATE SCHEMA "S";', 'REVOKE ALL ON SCHEMA "S" FROM PUBLIC;'],
    ['CREATE SCHEMA S;', 'REVOKE ALL ON SCHEMA "s" FROM PUBLIC;'],
    ["-- ratio:allow-function helper\nCREATE FUNCTION ratio.\"F\"(x INT) RETURNS int LANGUAGE sql AS 'select 1';", 'REVOKE EXECUTE ON FUNCTION ratio."F"(int) FROM PUBLIC;'],
  ];
  for (const [create, revoke] of expand) {
    it(`expand: ${create.split('\n').pop()} then ${revoke}`, () => {
      expect(findNonExpandStatement(t(create, revoke))).toBeNull();
    });
  }
});
