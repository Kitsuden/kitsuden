/**
 * Icon name → lucide component
 * ============================================================================
 *
 * The manifests (`kon.json`) and the registry's `getDefaultIcon` declare the
 * icon as the NAME of a component: `Gamepad2`, `FileText`, `Tv`…
 * Here it is translated to a component, and it is used by both the cards in the
 * kon list and the side menu.
 *
 * ── WHY A STATIC MAP ───────────────────────────────────────────────────────
 *
 * The first attempt was a dynamic import marked `@vite-ignore`. It failed in the
 * worst way: that mark means "do not analyze this", so Vite bundled NO icon at
 * all and the browser received a bare specifier it cannot resolve. Every import
 * failed, everything showed the fallback icon, and the screen looked designed
 * that way — without a single error.
 *
 * A static map forces Vite to include exactly these, without pulling in the
 * ~1500 in the package.
 *
 * ── HOW IT IS KEPT FROM GOING STALE ────────────────────────────────────────
 *
 * `tests/unit/kon-icons.test.ts` compares the names declared in the manifests
 * with the keys here, and fails naming the missing one. Without that test, a kon
 * with a new icon would silently fall back to the generic one.
 */

import Activity from "lucide-svelte/icons/activity";
import Archive from "lucide-svelte/icons/archive";
import ArrowRight from "lucide-svelte/icons/arrow-right";
import Award from "lucide-svelte/icons/award";
import BarChart3 from "lucide-svelte/icons/bar-chart-3";
import Bell from "lucide-svelte/icons/bell";
import BookOpen from "lucide-svelte/icons/book-open";
import BrainCircuit from "lucide-svelte/icons/brain-circuit";
import Briefcase from "lucide-svelte/icons/briefcase";
import Building from "lucide-svelte/icons/building";
import Building2 from "lucide-svelte/icons/building-2";
import Calendar from "lucide-svelte/icons/calendar";
import CalendarCheck from "lucide-svelte/icons/calendar-check";
import CalendarDays from "lucide-svelte/icons/calendar-days";
import CalendarX from "lucide-svelte/icons/calendar-x";
import Check from "lucide-svelte/icons/check";
import CircleCheck from "lucide-svelte/icons/circle-check";
import CircleCheckBig from "lucide-svelte/icons/circle-check-big";
import CircleDot from "lucide-svelte/icons/circle-dot";
import CircleHelp from "lucide-svelte/icons/circle-help";
import CircleUser from "lucide-svelte/icons/circle-user";
import ClipboardList from "lucide-svelte/icons/clipboard-list";
import Clock from "lucide-svelte/icons/clock";
import Coins from "lucide-svelte/icons/coins";
import Columns3 from "lucide-svelte/icons/columns-3";
import IconComponent from "lucide-svelte/icons/component";
import Contact from "lucide-svelte/icons/contact";
import Cpu from "lucide-svelte/icons/cpu";
import CreditCard from "lucide-svelte/icons/credit-card";
import Database from "lucide-svelte/icons/database";
import DoorOpen from "lucide-svelte/icons/door-open";
import Download from "lucide-svelte/icons/download";
import FileScan from "lucide-svelte/icons/file-scan";
import FileStack from "lucide-svelte/icons/file-stack";
import FileText from "lucide-svelte/icons/file-text";
import FolderKanban from "lucide-svelte/icons/folder-kanban";
import FolderTree from "lucide-svelte/icons/folder-tree";
import Gamepad2 from "lucide-svelte/icons/gamepad-2";
import GitBranch from "lucide-svelte/icons/git-branch";
import Globe from "lucide-svelte/icons/globe";
import GraduationCap from "lucide-svelte/icons/graduation-cap";
import Hammer from "lucide-svelte/icons/hammer";
import History from "lucide-svelte/icons/history";
import Image from "lucide-svelte/icons/image";
import Inbox from "lucide-svelte/icons/inbox";
import Kanban from "lucide-svelte/icons/kanban";
import KeyRound from "lucide-svelte/icons/key-round";
import Landmark from "lucide-svelte/icons/landmark";
import Layers from "lucide-svelte/icons/layers";
import LayoutDashboard from "lucide-svelte/icons/layout-dashboard";
import Library from "lucide-svelte/icons/library";
import Link from "lucide-svelte/icons/link";
import Link2 from "lucide-svelte/icons/link-2";
import List from "lucide-svelte/icons/list";
import ListOrdered from "lucide-svelte/icons/list-ordered";
import LogIn from "lucide-svelte/icons/log-in";
import Mail from "lucide-svelte/icons/mail";
import Map from "lucide-svelte/icons/map";
import MapPin from "lucide-svelte/icons/map-pin";
import MessageCircle from "lucide-svelte/icons/message-circle";
import MessageSquare from "lucide-svelte/icons/message-square";
import Monitor from "lucide-svelte/icons/monitor";
import Network from "lucide-svelte/icons/network";
import Package from "lucide-svelte/icons/package";
import Paperclip from "lucide-svelte/icons/paperclip";
import Pencil from "lucide-svelte/icons/pencil";
import Play from "lucide-svelte/icons/play";
import Plus from "lucide-svelte/icons/plus";
import Receipt from "lucide-svelte/icons/receipt";
import Route from "lucide-svelte/icons/route";
import Save from "lucide-svelte/icons/save";
import Scale from "lucide-svelte/icons/scale";
import ScanText from "lucide-svelte/icons/scan-text";
import Shield from "lucide-svelte/icons/shield";
import ShoppingBag from "lucide-svelte/icons/shopping-bag";
import Sigma from "lucide-svelte/icons/sigma";
import Sparkles from "lucide-svelte/icons/sparkles";
import StickyNote from "lucide-svelte/icons/sticky-note";
import Swords from "lucide-svelte/icons/swords";
import Tag from "lucide-svelte/icons/tag";
import Tags from "lucide-svelte/icons/tags";
import ThumbsUp from "lucide-svelte/icons/thumbs-up";
import Timer from "lucide-svelte/icons/timer";
import TrendingUp from "lucide-svelte/icons/trending-up";
import Trophy from "lucide-svelte/icons/trophy";
import Tv from "lucide-svelte/icons/tv";
import User from "lucide-svelte/icons/user";
import UserPlus from "lucide-svelte/icons/user-plus";
import Users from "lucide-svelte/icons/users";
import Webhook from "lucide-svelte/icons/webhook";
import X from "lucide-svelte/icons/x";

/**
 * Declared name → component.
 *
 * The last three aliases are icons that lucide RENAMED; the manifests still
 * use the old name.
 */
export const ICONS: Record<string, typeof Package> = {
  Activity,
  ArrowRight,
  Award,
  BarChart3,
  Bell,
  BookOpen,
  BrainCircuit,
  Briefcase,
  Building,
  Building2,
  Calendar,
  CalendarCheck,
  CalendarDays,
  CalendarX,
  Check,
  CircleDot,
  ClipboardList,
  Clock,
  Coins,
  Columns3,
  // The icon is imported as `IconComponent`: `Component` is a Svelte type.
  Component: IconComponent,
  Contact,
  Cpu,
  CreditCard,
  Database,
  DoorOpen,
  Download,
  FileScan,
  FileStack,
  Archive,
  FileText,
  Globe,
  FolderKanban,
  FolderTree,
  Gamepad2,
  GitBranch,
  GraduationCap,
  Hammer,
  History,
  Image,
  Inbox,
  Kanban,
  KeyRound,
  Landmark,
  Layers,
  LayoutDashboard,
  Library,
  Link,
  Link2,
  List,
  ListOrdered,
  LogIn,
  Mail,
  Map,
  MapPin,
  MessageCircle,
  MessageSquare,
  Monitor,
  Network,
  Package,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Receipt,
  Route,
  Save,
  Scale,
  ScanText,
  Shield,
  ShoppingBag,
  Sigma,
  Sparkles,
  StickyNote,
  Swords,
  Tag,
  Tags,
  ThumbsUp,
  Timer,
  TrendingUp,
  Trophy,
  Tv,
  User,
  UserPlus,
  Users,
  Webhook,
  X,
  CircleCheckBig,
  CheckCircle: CircleCheck,
  HelpCircle: CircleHelp,
  UserCircle: CircleUser,
};

/** Icon component, or the generic one if the name is not mapped. */
export function iconByName(name?: string | null): typeof Package {
  return (name && ICONS[name]) || Package;
}
