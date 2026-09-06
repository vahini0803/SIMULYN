variable "location" {
  description = "Azure region. South India keeps latency low for the university."
  type        = string
  default     = "southindia"
}

variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
  default     = "simulyn"
}

variable "dns_label" {
  description = <<-EOT
    Azure-provided DNS label. The cluster becomes reachable at
    <dns_label>.<location>.cloudapp.azure.com once the ingress controller
    claims the public IP with this label. Must be unique within the region.
  EOT
  type        = string
  default     = "simulyn"
}

variable "node_vm_size" {
  description = "Node SKU. B2s is 2 vCPU / 4 GB — see the capacity note in the plan before lowering it."
  type        = string
  default     = "Standard_B2s"
}

variable "node_min_count" {
  description = "Autoscaler floor."
  type        = number
  default     = 1
}

variable "node_max_count" {
  description = "Autoscaler ceiling. Executor replicas are what push this up during exams."
  type        = number
  default     = 3
}

variable "acr_sku" {
  description = "Basic is enough for three images."
  type        = string
  default     = "Basic"
}

variable "tags" {
  description = "Applied to every resource, so cost reports can be split by purpose."
  type        = map(string)
  default = {
    project = "simulyn"
    managed = "terraform"
  }
}
