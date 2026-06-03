from .admin import router as admin_router
from .platform import router as platform_router
from .users import router as users_router
from .topology import router as topology_router
from .auth import router as auth_router
from .maintenance import router as maintenance_router
from .channels import router as channels_router
from .credentials import router as credentials_router
from .devices import router as devices_router
from .discovery import router as discovery_router
from .interfaces import router as interfaces_router
from .alerts import router as alerts_router
from .overview import router as overview_router
from .policies import router as policies_router
from .flow import router as flow_router
from .syslog import router as syslog_router
from .config_mgmt import router as config_router
from .collectors import router as collectors_router
from .bgp import router as bgp_router
from .api_methods import router as api_methods_router
from .clients import router as clients_router
from .search import router as search_router
from .traps import router as traps_router

__all__ = ["admin_router", "platform_router", "auth_router", "bgp_router", "collectors_router", "config_router",
           "flow_router", "syslog_router", "topology_router", "channels_router",
           "credentials_router", "maintenance_router", "devices_router",
           "discovery_router", "interfaces_router", "alerts_router",
           "overview_router", "policies_router", "users_router", "api_methods_router",
           "clients_router", "search_router", "traps_router"]
