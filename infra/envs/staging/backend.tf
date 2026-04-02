terraform {
  backend "s3" {
    bucket         = "swiftagent-terraform-state"
    key            = "staging/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "swiftagent-terraform-locks"
    encrypt        = true
  }
}

# One-time bootstrap (manual):
# 1. Create S3 bucket "swiftagent-terraform-state" with versioning and encryption enabled
# 2. Create DynamoDB table "swiftagent-terraform-locks" with partition key "LockID" (String)
