terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
      # 4.x renamed many AKS arguments (enable_auto_scaling -> auto_scaling_enabled).
      # If you must stay on 3.x, that rename is the only change needed here.
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State is local by default, which is fine for one operator. For a team, move
  # it to a storage account so two people cannot apply over each other:
  #
  # backend "azurerm" {
  #   resource_group_name  = "rg-simulyn-tfstate"
  #   storage_account_name = "simulyntfstate"
  #   container_name       = "tfstate"
  #   key                  = "simulyn.tfstate"
  # }
}

provider "azurerm" {
  features {}
}
