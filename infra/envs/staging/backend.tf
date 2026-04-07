terraform {
  backend "s3" {
    bucket         = "swiftagent-tf-state"
    key            = "staging/terraform.tfstate"
    dynamodb_table = "swiftagent-terraform-locks"
    encrypt        = true
  }
}

# One-time bootstrap (manual):
# 1. Create S3 bucket "swiftagent-tf-state" with versioning and encryption enabled
# 2. Create DynamoDB table "swiftagent-terraform-locks" with partition key "LockID" (String)
