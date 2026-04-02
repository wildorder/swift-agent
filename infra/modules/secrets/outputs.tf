output "parameter_arns" {
  description = "Map of parameter name to SSM parameter ARN"
  value       = local.parameter_arns
}

output "parameter_names" {
  description = "Map of parameter name to SSM parameter path"
  value       = local.parameter_names
}
