# ── naming ─────────────────────────────────────────────────────────────
# ACR names share one global namespace, so a fixed "simulynacr" is very likely
# already taken by someone else. A short random suffix makes the apply succeed
# on the first try; it is kept in state, so it stays stable across applies.
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_resource_group" "simulyn" {
  name     = "rg-${var.name_prefix}"
  location = var.location
  tags     = var.tags
}

# ── container registry ─────────────────────────────────────────────────
resource "azurerm_container_registry" "acr" {
  name                = "${var.name_prefix}acr${random_string.suffix.result}"
  resource_group_name = azurerm_resource_group.simulyn.name
  location            = azurerm_resource_group.simulyn.location
  sku                 = var.acr_sku

  # The AcrPull role assignment below is what AKS actually uses. The admin
  # account exists only as a fallback for `docker login` from a laptop.
  admin_enabled = false

  tags = var.tags
}

# ── kubernetes ─────────────────────────────────────────────────────────
resource "azurerm_kubernetes_cluster" "aks" {
  name                = "aks-${var.name_prefix}"
  location            = azurerm_resource_group.simulyn.location
  resource_group_name = azurerm_resource_group.simulyn.name
  dns_prefix          = var.name_prefix
  sku_tier            = "Free"

  default_node_pool {
    name            = "default"
    vm_size         = var.node_vm_size
    os_disk_size_gb = 30

    # 3.x calls this `enable_auto_scaling`.
    auto_scaling_enabled = true
    min_count            = var.node_min_count
    max_count            = var.node_max_count

    # Required so a vm_size or disk change can roll a replacement pool in
    # rather than failing the apply.
    temporary_name_for_rotation = "temppool"

    upgrade_settings {
      max_surge = "33%"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin = "azure"
    # Overlay hands pods their own address space instead of burning one VNet IP
    # per pod. On a small cluster that is the difference between fitting the
    # executor pool and running out of subnet.
    network_plugin_mode = "overlay"
    load_balancer_sku   = "standard"
    outbound_type       = "loadBalancer"

    # Without a policy engine the cluster accepts NetworkPolicy objects and
    # then ignores them, which is worse than not having them — the executor
    # egress lockdown in infra/k8s/network-policy.yaml depends on this.
    network_policy = "calico"
  }

  # Untrusted student code runs on these nodes; keep them patched.
  automatic_upgrade_channel = "patch"

  tags = var.tags

  lifecycle {
    # The autoscaler owns the replica count once the cluster is live.
    ignore_changes = [default_node_pool[0].node_count]
  }
}

# Lets kubelet pull from ACR without an imagePullSecret.
resource "azurerm_role_assignment" "aks_acr_pull" {
  principal_id                     = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
  role_definition_name             = "AcrPull"
  scope                            = azurerm_container_registry.acr.id
  skip_service_principal_aad_check = true
}
