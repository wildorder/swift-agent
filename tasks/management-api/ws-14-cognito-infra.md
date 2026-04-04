# WS-14: Cognito User Pool Infrastructure

## Goal

Add a reusable Terraform module that provisions a shared AWS Cognito User Pool for Swift Agent management API authentication (OIDC for the marketing site and dashboard), persists the runtime-facing identifiers in SSM under the existing `/${environment}/swiftagent/{KEY}` convention, and wires the module into the dev environment so ECS task roles continue to receive a complete SSM ARN allowlist.

## Dependencies

- **WS-13a** (Terraform Foundation) — must be complete so `infra/` layout, backend, and module composition patterns are stable before adding Cognito.

## Context Files (Agent MUST read before implementing)

- `c:\dev\swift-agent\infra\versions.tf` — Terraform and provider pins (`>= 1.5`, AWS `~> 5.0`, random `~> 3.6`).
- `c:\dev\swift-agent\infra\envs\dev\main.tf` — how modules are composed; `iam` and `ecs` consume `module.secrets.parameter_arns` today.
- `c:\dev\swift-agent\infra\modules\secrets\main.tf` — SSM naming: `/${var.environment}/swiftagent/...`, `locals.parameter_arns` map pattern.
- `c:\dev\swift-agent\infra\modules\secrets\outputs.tf` — `parameter_arns` / `parameter_names` output shape.
- `c:\dev\swift-agent\infra\modules\iam\` — how `ssm_parameter_arns` is consumed (must include new Cognito parameter ARNs after merge).
- `c:\dev\swift-agent\infra\modules\ecs\` — `ssm_parameter_arns` passed through for task access.

## Package

`infra/modules/cognito/` (new module), integrated from `infra/envs/dev/` (and the same pattern for other env roots when they exist).

## Files Touched

- `infra/modules/cognito/main.tf` **(NEW)** — User Pool, User Pool Client, User Pool Domain, SSM parameters, supporting data sources (e.g. `aws_region`).
- `infra/modules/cognito/variables.tf` **(NEW)** — `environment`, `callback_urls`, `logout_urls`, `domain_prefix` (Cognito hosted domain prefix; distinct from Route53 `domain_prefix` in the dev root if both exist—pass explicitly to avoid naming collisions).
- `infra/modules/cognito/outputs.tf` **(NEW)** — Pool ID, issuer URL, JWKS URI, app client ID, maps of SSM parameter ARNs (and names if useful for symmetry with `secrets`).
- `infra/envs/dev/main.tf` **(MODIFY)** — `module "cognito" { ... }`; merge Cognito SSM ARN map with `module.secrets.parameter_arns` when passing into `module.iam` and `module.ecs` (replace bare `module.secrets.parameter_arns` where a merged map is required). Add dev-level variables for `callback_urls`, `logout_urls`, and Cognito `domain_prefix` if not hardcoded.

## Implementation Steps

1. **User Pool** — Create `aws_cognito_user_pool` with email as a sign-in alias; enable self-registration if product requires public sign-up (email-based sign-up). Set **password policy**: minimum length **8**, require uppercase, lowercase, number, and symbol. Enable **email verification** using Cognito’s built-in email (default `email_configuration` / verification message attributes as appropriate for AWS provider 5.x).
2. **App client** — Create `aws_cognito_user_pool_client` with **authorization code grant**; enable **PKCE**. Allowed OAuth scopes: `openid`, `email`, `profile`. Set `callback_urls` and `logout_urls` from module variables (lists of strings). Disable client secret (public SPA-style client). Set supported identity providers to Cognito only unless later extended.
3. **Hosted domain** — Create `aws_cognito_user_pool_domain` using `domain_prefix` (Cognito domain prefix for `https://{prefix}.auth.{region}.amazoncognito.com`). Ensure prefix is globally unique for the account/region.
4. **Issuer and JWKS** — Compute **issuer URL** as `https://cognito-idp.{region}.amazonaws.com/{user_pool_id}` (use `data.aws_region.current` and pool id). Output **JWKS URI** as `${issuer_url}/.well-known/jwks.json` (string interpolation in Terraform; no extra resource).
5. **SSM parameters** — Create `aws_ssm_parameter` resources (type `String` is acceptable for non-secret IDs/URLs; use `SecureString` only if treating client id as sensitive—follow project consistency) for:
   - `COGNITO_USER_POOL_ID`
   - `COGNITO_ISSUER_URL`
   - `COGNITO_CLIENT_ID`  
   Paths: `/${var.environment}/swiftagent/{KEY}` matching `secrets` module style.
6. **Module outputs** — Export: `user_pool_id`, `issuer_url`, `jwks_uri`, `app_client_id`, and a **map** of SSM parameter ARNs keyed by logical names (e.g. `COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`, `COGNITO_CLIENT_ID`) so the root module can `merge()` with `module.secrets.parameter_arns`.
7. **Wire dev** — In `infra/envs/dev/main.tf`, instantiate `module "cognito"` with `environment = var.environment`, appropriate `callback_urls`, `logout_urls`, and `domain_prefix`. Merge `module.secrets.parameter_arns` and the Cognito ARN map (`merge(...)`) for inputs to `module.iam` and `module.ecs` that enumerate SSM ARNs. Add variables (and `terraform.tfvars` / docs as the repo already does) for marketing-site callback/logout URLs and domain prefix.
8. **Documentation** — Short inline descriptions in `variables.tf` for URL list format (e.g. `https://site/callback`) and Cognito domain prefix constraints.

## Tests

1. From the relevant Terraform root (e.g. `infra/envs/dev`), run `terraform init -backend=false` (or full init if policy requires) and `terraform validate` — must exit zero.
2. Run `terraform plan` with appropriate vars/backend — plan must show creation of the User Pool, User Pool Client, User Pool Domain, three SSM parameters, and no unintended destruction of existing modules.
3. Optionally run `terraform fmt -check` on touched `.tf` files in CI or locally.

## Acceptance Criteria

1. `infra/modules/cognito/` exists with `main.tf`, `variables.tf`, and `outputs.tf`, following the same structural pattern as other modules under `infra/modules/`.
2. User Pool enforces the stated password policy and email verification for sign-up/sign-in flows Cognito supports with the chosen attributes.
3. App client uses authorization code flow with PKCE enabled; `openid`, `email`, and `profile` scopes are allowed; callback and logout URLs are driven by module variables.
4. Cognito hosted domain exists for `domain_prefix` and OIDC metadata is reachable in principle (issuer URL matches `https://cognito-idp.{region}.amazonaws.com/{pool_id}`).
5. SSM parameters exist at `/${environment}/swiftagent/COGNITO_USER_POOL_ID`, `COGNITO_ISSUER_URL`, and `COGNITO_CLIENT_ID` with correct values.
6. Module outputs include User Pool ID, Issuer URL, JWKS URI (`${issuer_url}/.well-known/jwks.json`), App Client ID, and SSM parameter ARNs in a map suitable for merging with `module.secrets.parameter_arns`.
7. `infra/envs/dev/main.tf` declares the `cognito` module and merges Cognito SSM ARNs into IAM/ECS SSM allowlists so tasks can read the new parameters.
8. `terraform validate` passes; `terraform plan` shows the expected new resources and dependency order without replacing unrelated infrastructure.
