# Card A2 mutation checks

Each mutation was applied to one source file, `npx vitest run src/mock/idp/idp.test.ts` was run, and the file was restored. Script output:

| Mutation | Result | Killed by |
|---|---|---|
| M1 skip signature check | killed | verify_rejects_tampered_role_claim |
| M2 accept any alg | killed | verify_rejects_alg_none_and_hs256_confusion |
| M3 drop audience check | killed | single_use_token_replay_fails_second_time, verify_rejects_wrong_audience_env |
| M4 expiry off by one | killed | single_use_token_replay_fails_second_time, verify_rejects_expired_token |
| M5 ignore revocation | killed | idp_state_is_shared_across_separately_loaded_module_instances, role_change_reissue_reflects_new_claims_and_old_token_is_revoked, verify_rejects_revoked_jti |
| M6 one-time token never marked used | killed | idp_state_is_shared_across_separately_loaded_module_instances, single_use_token_replay_fails_second_time |
| M7 gate trims RATIO_ENV | killed | issuer_refuses_to_run_unless_mock_idp_enabled, mock_idp_enabled_table |
| M8 gate accepts any truthy flag | killed | issuer_refuses_to_run_unless_mock_idp_enabled, mock_idp_enabled_table |
| M9 gate allows staging | killed | issuer_refuses_to_run_unless_mock_idp_enabled, mock_idp_enabled_table |
| M10 gate reads inherited props | killed | mock_idp_enabled_table |
| M11 retire does not remove key | killed | key_rotation_old_kid_rejected_after_retire |
| M12 reissue keeps old tokens valid | killed | role_change_reissue_reflects_new_claims_and_old_token_is_revoked |
| M13 issuer skips claim validation | killed | issues_token_with_role_team_env_tenant_claims |
| M14 header extra params allowed | killed | verify_rejects_alg_none_and_hs256_confusion |
| M15 no canonical base64url check | killed | verify_rejects_tampered_role_claim |
| M16 login token accepted as session | killed | single_use_token_replay_fails_second_time |
| M17 wildcard allowed inside team list | killed | issues_token_with_role_team_env_tenant_claims, verify_rejects_wrong_audience_env |
| M18 eng-cx on a non-seeded team | killed | persona_catalogue_has_two_eng_leads_on_distinct_real_team_names |
| M19 module-local state | killed | idp_state_is_shared_across_separately_loaded_module_instances |
| M20 verifier skips the gate | killed | issuer_refuses_to_run_unless_mock_idp_enabled |
| M21 issuer skips the gate | killed | issuer_refuses_to_run_unless_mock_idp_enabled |
| M22 extra claims allowed | killed | verify_rejects_wrong_audience_env |
| M23 role not restricted to personas | killed | issues_token_with_role_team_env_tenant_claims, verify_rejects_wrong_audience_env |
| M24 iat in the future accepted | killed | verify_rejects_expired_token |
| M25 error carries the token | killed | no_key_or_token_material_in_console_output |
| M26 issuer logs the token | killed | no_key_or_token_material_in_console_output |
| M27 JWKS exports private scalar | killed | key_rotation_old_kid_rejected_after_retire, no_key_or_token_material_in_console_output |

M15 survived on the first pass; the respelled-signature assertion in verify_rejects_tampered_role_claim was added to kill it. All 27 killed; `git diff` on the sources clean afterward.
