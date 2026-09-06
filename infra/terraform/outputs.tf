output "resource_group_name" {
  value = azurerm_resource_group.simulyn.name
}

output "acr_name" {
  description = "Feed this to the ACR_NAME GitHub secret."
  value       = azurerm_container_registry.acr.name
}

output "acr_login_server" {
  description = "Feed this to the ACR_LOGIN_SERVER GitHub secret."
  value       = azurerm_container_registry.acr.login_server
}

output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "public_hostname" {
  description = <<-EOT
    Where the app will answer once the ingress controller has claimed the
    public IP with this DNS label. Nothing resolves here until the
    ingress-nginx install in the Phase 3 checklist has run.
  EOT
  value = "${var.dns_label}.${var.location}.cloudapp.azure.com"
}

output "kube_config" {
  value     = azurerm_kubernetes_cluster.aks.kube_config_raw
  sensitive = true
}
