terraform {
  backend "s3" {
    # Prod state lives in the SwiftAgent-prod account (548722509196). The
    # bucket name embeds the account id because S3 names are GLOBAL and the
    # dev account already owns "swiftagent-tf-state".
    bucket         = "swiftagent-tf-state-548722509196"
    key            = "prod/terraform.tfstate"
    dynamodb_table = "swiftagent-terraform-locks"
    encrypt        = true
  }
}

# One-time bootstrap (performed 2026-08-21 in 548722509196):
# 1. S3 bucket "swiftagent-tf-state-548722509196" — versioned, KMS-encrypted,
#    public access blocked
# 2. DynamoDB table "swiftagent-terraform-locks" — partition key "LockID" (String)
