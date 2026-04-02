#!/usr/bin/env bash
set -euo pipefail

# Migration script for ECS RunTask
# Runs Drizzle migrations against the database
# Exit non-zero on failure to halt deployment

echo "=== Swift Agent Database Migration ==="
echo "Environment: ${ENVIRONMENT:-unknown}"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 1: Verify database connectivity
echo "Verifying database connectivity..."
node -e "
  import('postgres').then(({ default: postgres }) => {
    const sql = postgres(process.env.DATABASE_URL);
    sql\`SELECT 1\`.then(() => {
      console.log('Database connection verified');
      sql.end();
    }).catch(err => {
      console.error('Database connection failed:', err.message);
      process.exit(1);
    });
  });
"

# Step 2: Run Drizzle migrations
echo "Running database migrations..."
node dist/migrate.js

echo "=== Migration completed successfully ==="

# Manual rollback instructions:
# 1. Revert ECS service to previous task definition:
#    aws ecs update-service --cluster <cluster> --service <service> --task-definition <previous-task-def>
# 2. If schema changes need reverting, restore RDS from the pre-deploy snapshot:
#    aws rds restore-db-instance-from-db-snapshot --db-instance-identifier <instance> --db-snapshot-identifier <snapshot>
# 3. Update SSM parameters if connection strings changed
