import {
  LayoutGrid,
  Settings,
  LogOut,
  CreditCard,
  HelpCircle,
  ShieldAlert,
  Users,
  CheckSquare,
  Bot,
  FolderOpen,
  HardHat,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useProjects } from "@/hooks/useProjects";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Link, useLocation } from "react-router-dom";
import { config } from "@/lib/config";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const gcNavItems = [
  { title: "Dashboard", url: "/", icon: LayoutGrid },
  { title: "My Tasks", url: "/my-tasks", icon: CheckSquare },
  { title: "Team", url: "/team", icon: Users },
];

const subNavItems = [
  { title: "My Projects", url: "/", icon: HardHat },
  { title: "My Tasks", url: "/my-tasks", icon: CheckSquare },
  { title: "Team", url: "/team", icon: Users },
];

const accountItems = [
  { title: "Settings", url: "/settings", icon: Settings },
  { title: "Billing", url: "/billing", icon: CreditCard },
  { title: "Help", url: "/help", icon: HelpCircle },
  { title: "System Admin", url: "/admin", icon: ShieldAlert },
];

export function AppSidebar({ onOpenChat }: { onOpenChat?: () => void }) {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const { logout, user, role, profile } = useAuth();
  const { company } = useCompany();
  const { projects } = useProjects();
  const location = useLocation();
  const displayName = profile?.displayName ?? user?.displayName ?? user?.email?.split("@")[0] ?? "User";

  const isSub = company?.companyType === "SUB";
  const navItems = isSub ? subNavItems : gcNavItems;
  const activeProjects = projects.filter((p) => p.status === "ACTIVE");

  return (
    <Sidebar collapsible="icon">

      {/* Header */}
      <SidebarHeader className="px-3 py-3">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <div className="h-7 w-7 rounded-md gradient-bg flex items-center justify-center text-white font-bold text-sm">
              F
            </div>
            <SidebarTrigger />
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-md gradient-bg flex items-center justify-center text-white font-bold text-base shrink-0">
                F
              </div>
              <div>
                <span className="text-base font-bold tracking-tight whitespace-nowrap gradient-text">
                  FieldStack
                </span>
                {company && (
                  <div className="text-[10px] text-muted-foreground font-mono truncate max-w-28">{company.name}</div>
                )}
              </div>
            </div>
            <SidebarTrigger />
          </div>
        )}
      </SidebarHeader>

      {/* Nav */}
      <SidebarContent>
        <SidebarGroup>
          {!collapsed && <SidebarGroupLabel>Navigation</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild>
                        <NavLink
                          to={item.url}
                          end
                          className={collapsed ? "flex justify-center px-0" : "hover:bg-muted/50"}
                          activeClassName="bg-muted text-primary font-medium"
                        >
                          <item.icon className={`h-4 w-4 shrink-0 ${!collapsed ? "mr-2" : ""}`} />
                          {!collapsed && <span>{item.title}</span>}
                        </NavLink>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {collapsed && <TooltipContent side="right">{item.title}</TooltipContent>}
                  </Tooltip>
                </SidebarMenuItem>
              ))}
              {/* AI Foreman button (GC only) */}
              {!isSub && onOpenChat && (
                <SidebarMenuItem>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton asChild>
                        <button
                          onClick={onOpenChat}
                          className={`flex items-center w-full hover:bg-muted/50 rounded-md px-2 py-1.5 text-sm ${collapsed ? "justify-center px-0" : ""}`}
                        >
                          <Bot className={`h-4 w-4 shrink-0 ${!collapsed ? "mr-2" : ""}`} />
                          {!collapsed && <span>AI Foreman</span>}
                        </button>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    {collapsed && <TooltipContent side="right">AI Foreman</TooltipContent>}
                  </Tooltip>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Active Projects (GC only) */}
        {!isSub && !collapsed && activeProjects.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Active Projects</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {activeProjects.map((p) => {
                  const isActive = location.pathname.startsWith(`/projects/${p.id}`);
                  const hasCritical = (p.alertCounts?.critical ?? 0) > 0;
                  const hasWarning = (p.alertCounts?.warning ?? 0) > 0;
                  return (
                    <SidebarMenuItem key={p.id}>
                      <SidebarMenuButton asChild>
                        <Link
                          to={`/projects/${p.id}`}
                          className={`flex items-center justify-between gap-2 hover:bg-muted/50 rounded-md px-2 py-1.5 ${isActive ? "bg-muted text-primary font-medium" : ""}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasCritical ? "bg-red-500" : hasWarning ? "bg-yellow-500" : "bg-emerald-500"}`} />
                            <span className="text-xs truncate">{p.name}</span>
                          </div>
                          {hasCritical && (
                            <span className="text-[9px] bg-destructive text-destructive-foreground px-1 rounded-full shrink-0">
                              {p.alertCounts!.critical}
                            </span>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          {!collapsed && <SidebarGroupLabel>Account</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu>
              {accountItems
                .filter((item) => item.title !== "System Admin" || role === "admin")
                .map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <SidebarMenuButton asChild>
                          <NavLink
                            to={item.url}
                            end
                            className={collapsed ? "flex justify-center px-0" : "hover:bg-muted/50"}
                            activeClassName="bg-muted text-primary font-medium"
                          >
                            <item.icon className={`h-4 w-4 shrink-0 ${!collapsed ? "mr-2" : ""}`} />
                            {!collapsed && <span>{item.title}</span>}
                          </NavLink>
                        </SidebarMenuButton>
                      </TooltipTrigger>
                      {collapsed && <TooltipContent side="right">{item.title}</TooltipContent>}
                    </Tooltip>
                  </SidebarMenuItem>
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Footer */}
      <SidebarFooter className="p-3">
        <Separator className="mb-3" />

        <div className={`flex mb-3 ${collapsed ? "justify-center" : "items-center gap-3 px-2"}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Avatar className="h-8 w-8 shrink-0 cursor-default">
                <AvatarFallback className="gradient-bg text-white text-sm font-semibold">
                  {displayName[0]?.toUpperCase() ?? "?"}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            {collapsed && <TooltipContent side="right">{displayName}</TooltipContent>}
          </Tooltip>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{displayName}</p>
            </div>
          )}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className={`w-full gap-2 text-muted-foreground ${collapsed ? "justify-center px-0" : "justify-start"}`}
            >
              <LogOut className="h-4 w-4 shrink-0" />
              {!collapsed && <span>Log out</span>}
            </Button>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">Log out</TooltipContent>}
        </Tooltip>

        {!collapsed && (
          <p className="text-[10px] text-muted-foreground/50 text-center mt-1 select-none">
            v{__APP_VERSION__}
          </p>
        )}
      </SidebarFooter>

    </Sidebar>
  );
}
