# Phase 2's Editorial Workbench (Directus) wiring, in its own file per
# development/branching.md ("each phase owns its own infra"). The image
# lives in the shared ECR repo (terraform/bootstrap/ecr.tf) — mirrored
# there by CI (.github/workflows/mirror-directus-image.yml) since the
# private-isolated tier this task runs in has no NAT/internet route to
# pull from Docker Hub directly (ADR-009's reasoning, applied to ECS
# instead of Lambda). Directus is the sole write path into `catalog`
# (SPEC-03) — it connects with a stored password as the directus_app
# role (migration 20260101000006), not RDS Proxy IAM auth, since its
# Knex-based Postgres client has no dynamic token refresh support
# (infrastructure/secrets.md's stored-password exception).

locals {
  directus_ecr_repository_url = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/pk-literature/directus"
  directus_db_user            = module.secrets_manager.directus_db_username
}

data "aws_iam_policy_document" "directus_task" {
  statement {
    effect  = "Allow"
    actions = ["rds-db:connect"]
    resources = [
      "arn:aws:rds-db:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:dbuser:${module.rds_proxy.iam_auth_resource_id}/${local.directus_db_user}",
    ]
  }

  # S3 read/write for covers, publisher logos, promo banners (SPEC-03
  # "Media Management" / "Stored in Amazon S3").
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${module.s3.bucket_arn}/*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [module.s3.bucket_arn]
  }

  # infrastructure/iam.md's direct ecs-directus grant — the
  # eventbridge-put-event Flow operation (apps/directus/extensions)
  # calls PutEvents under this task role, not via a relay.
  statement {
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = [module.eventbridge.bus_arn]
  }
}

module "alb_directus" {
  source = "../../modules/alb"

  environment              = "prod"
  service_name             = "directus"
  vpc_id                   = module.vpc.vpc_id
  public_subnet_ids        = module.vpc.public_subnet_ids
  alb_security_group_id    = module.security_groups.alb_admin_sg_id
  domain_name              = var.domain_name
  regional_certificate_arn = module.route53_acm.regional_certificate_arn
  hosted_zone_id           = module.route53_acm.zone_id
  target_port              = 8055
  # Not /server/health - Directus 12.x deliberately restricted that
  # endpoint to authenticated requests (PR #27160, merged for v12.0.0:
  # "Restricted /server/health to authenticated users... use
  # /server/ping for liveness checks"), so every anonymous ALB health
  # check gets a real, working-as-designed 403 - confirmed live
  # (Directus's own request log: "GET /server/health 403"), which is
  # why the task kept cycling even after the health_check_grace_period
  # fix (that only delays ECS acting on a failing check, it doesn't
  # change what the check itself returns). /server/ping needs no auth
  # at all (registered directly in Directus's app.ts, always 200).
  health_check_path = "/server/ping"
}

module "ecs_directus" {
  source = "../../modules/ecs-service"

  environment    = "prod"
  service_name   = "directus"
  cluster_id     = aws_ecs_cluster.this.id
  image          = "${local.directus_ecr_repository_url}:${var.directus_image_tag}"
  container_port = 8055

  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.ecs_directus_sg_id]
  target_group_arn   = module.alb_directus.target_group_arn

  # Directus's official image runs its full migration/bootstrap sequence
  # on every container start (not just this repo's own DB migrations -
  # the built-in ~80 schema migrations, admin-user check, etc. all run
  # again each boot, idempotently but not instantly). Without a grace
  # period ECS starts acting on the ALB's failing health checks
  # immediately, kills the task mid-boot, and loops forever between
  # PROVISIONING/DEACTIVATING without ever converging - a real failure
  # mode hit live (runningCount stuck at 0, ELB health check failures).
  health_check_grace_period_seconds = 180

  # Enabled for live debugging: the account's role/policy/admin_access
  # state has been fully verified correct via the REST API (see
  # migration 20260101000018 and its follow-up investigation) yet
  # POST /collections still 403s inexplicably. ECS Exec gives a real
  # shell inside the running task to inspect the actual DB state (and
  # this repo's own migration-runner Lambda can't reach RDS from
  # CloudShell either, so this doubles as the fix for that standing
  # gap) and to run node directly against the live process instead of
  # guessing further from source-reading alone.
  enable_execute_command = true

  environment_variables = {
    DB_CLIENT = "pg"
    # Pointed at RDS directly, bypassing RDS Proxy — testing whether
    # RDS Proxy's connection multiplexing is behind Directus's own
    # bootstrap crashing identically on three different versions, all
    # through the proxy (see security-groups module's
    # ecs_directus_to_rds comment for the full reasoning). Revert to
    # module.rds_proxy.proxy_endpoint if this doesn't pan out.
    DB_HOST     = module.rds.db_address
    DB_PORT     = "5432"
    DB_DATABASE = "pk_literature"
    DB_USER     = local.directus_db_user
    # Directus/knex's env-to-config nesting uses a double
    # underscore for nested driver options (DB_SSL__<KEY> ->
    # connection.ssl.<key>), not a single underscore — the single-
    # underscore version silently did nothing, so RDS Proxy (which
    # requires TLS) rejected every connection with "This RDS Proxy
    # requires TLS connections", a real error from this task's own
    # logs. Presence of a non-empty ssl object is what actually
    # turns TLS on; a separate DB_SSL=true isn't needed.
    #
    # DB_SSL__CA_FILE (not DB_SSL__CA): a direct RDS connection (unlike
    # RDS Proxy) needs Amazon's own RDS CA bundle to verify — its
    # certificate doesn't chain to a publicly-trusted root the way RDS
    # Proxy's does. Directus's env-to-config loader only reads a
    # variable's value as a *file path* and substitutes its contents
    # when the name has the _FILE suffix (its documented docker-secrets
    # convention) — DB_SSL__CA alone treats the value as the literal CA
    # string, so a bare path here silently fails TLS verification
    # (real error from this task's own logs: "self-signed certificate
    # in certificate chain" - the RDS cert was never actually checked
    # against anything). Baked into the image at build time
    # (apps/directus/Dockerfile) at this exact path — the running task
    # has no internet route to fetch it itself (private-isolated tier,
    # ADR-009).
    DB_SSL__CA_FILE             = "/directus/rds-ca-bundle.pem"
    DB_SSL__REJECT_UNAUTHORIZED = "true"
    # public first: directus_app's own tables live there (migration
    # 20260101000015_directus_use_public_schema.sql) and the knex/pg
    # search_path convention resolves unqualified names against the
    # first matching schema in list order. catalog/staging added so
    # Directus's schema introspection (@directus/schema) can see
    # works/books/staging_books/etc - confirmed live this actually
    # works, unlike the README's documented *reverse* case (public
    # added as a fallback alongside directus's own non-public schema,
    # which never worked).
    #
    # discovery deliberately excluded, unlike the original version of
    # this list: directus_app's DB role was never granted USAGE on
    # that schema (it's api-feed's exclusive domain - interest_
    # profiles/interest_events/feed_shelves, no SPEC-03 editorial
    # relevance), and search_path only changes what Directus is
    # willing to LOOK for, not what its DB role can actually see -
    # confirmed live: including it broke GET /fields outright with a
    # raw Postgres "permission denied for schema discovery" (42501),
    # taking down the whole Admin UI (every page calls /fields). Least-
    # privilege is also the correct call here on its own terms, not
    # just the fix for the crash - Directus has no legitimate reason
    # to reach into api-feed's schema.
    DB_SEARCH_PATH = "public,catalog,staging"
    # Confirmed live: getExtensionsPath() (extensions/lib/get-
    # extensions-path.js) returns env["EXTENSIONS_PATH"] with no
    # fallback default in that code path - unset, this resolved to
    # undefined, resolveFsExtensions(undefined) found nothing, and
    # both eventbridge-put-event and promote-staging-book (real
    # files on disk, loaded cleanly per boot logs - "Extensions
    # loaded" with no error) never appeared anywhere: not in GET
    # /extensions/sources/index.js's bundle, not in Settings ->
    # Extensions ("no extensions installed yet"), not as a
    # selectable Flow operation type. Whatever default this Directus
    # version normally documents for this key evidently isn't
    # applied automatically in this deployment - set explicitly
    # instead of relying on it. Relative to WORKDIR (/directus,
    # confirmed via `pwd` inside the running container), matching
    # where the Dockerfile actually COPYs both extensions'
    # dist/package.json into.
    EXTENSIONS_PATH      = "extensions"
    PUBLIC_URL           = "https://directus.${var.domain_name}"
    ADMIN_EMAIL          = module.secrets_manager.directus_admin_email
    STORAGE_LOCATIONS    = "s3"
    STORAGE_S3_DRIVER    = "s3"
    STORAGE_S3_BUCKET    = module.s3.bucket_id
    STORAGE_S3_REGION    = data.aws_region.current.name
    EVENTBRIDGE_BUS_NAME = module.eventbridge.bus_name
    WEBSOCKETS_ENABLED   = "false"
  }

  secrets = {
    # :password:: extracts just that JSON key — the underlying secret
    # is jsonencode({ username, password }) so RDS Proxy's SECRETS auth
    # can match this role by username (see secrets-manager module's
    # directus_db comment); DB_PASSWORD still gets just the bare value.
    DB_PASSWORD    = "${module.secrets_manager.directus_db_password_secret_arn}:password::"
    KEY            = module.secrets_manager.directus_key_secret_arn
    SECRET         = module.secrets_manager.directus_secret_secret_arn
    ADMIN_PASSWORD = module.secrets_manager.directus_admin_password_secret_arn
    # Read by the decrement-inventory-stock operation's own handler
    # (context.env, same as eventbridge-put-event's STORAGE_S3_BUCKET
    # read) - gates its webhook Flow, which is otherwise reachable
    # without authentication by design. See secrets-manager module's
    # inventory_webhook_secret comment.
    INVENTORY_WEBHOOK_SECRET = module.secrets_manager.inventory_webhook_secret_secret_arn
  }

  additional_policy_json   = data.aws_iam_policy_document.directus_task.json
  attach_additional_policy = true
}
