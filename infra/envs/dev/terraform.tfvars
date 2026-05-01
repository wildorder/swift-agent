environment             = "dev"
aws_region              = "us-west-2"
db_instance_class       = "db.t4g.micro"
cache_node_type         = "cache.t4g.micro"
cpu                     = 256
memory                  = 512
desired_count           = 1
nat_gateway_count       = 1
multi_az                = false
backup_retention_period = 7
enable_autoscaling      = false
state_bucket_arn        = "arn:aws:s3:::swiftagent-tf-state"
lock_table_arn          = "arn:aws:dynamodb:us-west-2:992646609226:table/swiftagent-terraform-locks"
cognito_domain_prefix   = "swiftagent-dev"

# TODO: replace AppRunner URLs with custom domain once DNS is set up.
# Must stay in sync with auth_url in swift-agent-site's tfvars.
cognito_callback_urls = [
  "http://localhost:3000/api/auth/callback/cognito",
  "https://8zpwmhpuzp.us-west-2.awsapprunner.com/api/auth/callback/cognito",
]
cognito_logout_urls = [
  "http://localhost:3000",
  "https://8zpwmhpuzp.us-west-2.awsapprunner.com",
]
