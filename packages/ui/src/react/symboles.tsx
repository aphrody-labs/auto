// Icônes Material Symbols (Rounded) en composants React : SVG en ligne, couleur héritée (currentColor), taille par
// la classe `icone`. Les tracés viennent de symboles.gen.ts (scripts/symboles.ts).
import type { SVGProps } from "react";
import { TRACES } from "./symboles.gen";

export type Symbole = (p: SVGProps<SVGSVGElement>) => React.JSX.Element;

function symbole(nom: keyof typeof TRACES): Symbole {
  const Composant = (p: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 -960 960 960" fill="currentColor" focusable="false" {...p}>
      <path d={TRACES[nom]} />
    </svg>
  );
  Composant.displayName = `Symbole(${nom})`;
  return Composant;
}

export const Activity = symbole("Activity");
export const ArrowDown = symbole("ArrowDown");
export const ArrowLeft = symbole("ArrowLeft");
export const ArrowLeftRight = symbole("ArrowLeftRight");
export const ArrowRight = symbole("ArrowRight");
export const ArrowUp = symbole("ArrowUp");
export const BadgeEuro = symbole("BadgeEuro");
export const Ban = symbole("Ban");
export const Banknote = symbole("Banknote");
export const BellRing = symbole("BellRing");
export const Building2 = symbole("Building2");
export const CalendarDays = symbole("CalendarDays");
export const CalendarPlus = symbole("CalendarPlus");
export const Check = symbole("Check");
export const CircleAlert = symbole("CircleAlert");
export const CircleCheck = symbole("CircleCheck");
export const CircleX = symbole("CircleX");
export const ClockAlert = symbole("ClockAlert");
export const Copy = symbole("Copy");
export const CreditCard = symbole("CreditCard");
export const FileCheck = symbole("FileCheck");
export const FileCode2 = symbole("FileCode2");
export const FileDown = symbole("FileDown");
export const FileInput = symbole("FileInput");
export const FileOutput = symbole("FileOutput");
export const FilePlus2 = symbole("FilePlus2");
export const FileSpreadsheet = symbole("FileSpreadsheet");
export const FileText = symbole("FileText");
export const FolderOpen = symbole("FolderOpen");
export const ImageUp = symbole("ImageUp");
export const Inbox = symbole("Inbox");
export const KeyRound = symbole("KeyRound");
export const Landmark = symbole("Landmark");
export const LayoutDashboard = symbole("LayoutDashboard");
export const LogIn = symbole("LogIn");
export const LogOut = symbole("LogOut");
export const Menu = symbole("Menu");
export const Monitor = symbole("Monitor");
export const Moon = symbole("Moon");
export const Package = symbole("Package");
export const PackagePlus = symbole("PackagePlus");
export const Palette = symbole("Palette");
export const Pencil = symbole("Pencil");
export const Percent = symbole("Percent");
export const PlugZap = symbole("PlugZap");
export const Plus = symbole("Plus");
export const ReceiptText = symbole("ReceiptText");
export const RotateCcw = symbole("RotateCcw");
export const Save = symbole("Save");
export const Search = symbole("Search");
export const Send = symbole("Send");
export const Settings = symbole("Settings");
export const ShieldCheck = symbole("ShieldCheck");
export const Sun = symbole("Sun");
export const Trash2 = symbole("Trash2");
export const TriangleAlert = symbole("TriangleAlert");
export const Undo2 = symbole("Undo2");
export const Upload = symbole("Upload");
export const UserPlus = symbole("UserPlus");
export const UserRound = symbole("UserRound");
export const Users = symbole("Users");
export const X = symbole("X");
export const Bolt = symbole("Bolt");
export const ExpandMore = symbole("ExpandMore");
export const Extension = symbole("Extension");
export const Lock = symbole("Lock");
export const Smartphone = symbole("Smartphone");
export const Terminal = symbole("Terminal");
export const Workflow = symbole("Workflow");
export const Play = symbole("Play");
export const History = symbole("History");
export const DataObject = symbole("DataObject");
