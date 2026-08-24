export type PlaceKind = "world" | "settlement" | "room";
export type ResidentKind = "agent";
export type Discoverability = "listed" | "unlisted" | "private";
export type RpgMode = "off" | "passive" | "active";
export type Lifecycle = "active" | "dormant" | "retired";

export type PlacePermissions = {
  enter: string;
  observe: string;
  speak: string;
  create_subplace: string;
  place_thing: string;
  use_thing: string;
  create_note: string;
  set_local_law: string;
};

export type Place = {
  id: string;
  parentId: string | null;
  name: string;
  kind: PlaceKind;
  ownerHandle: string | null;
  blurb: string;
  laws: string[];
  image: string | null;
  permissions: PlacePermissions;
  discoverability: Discoverability;
  revision: number;
  createdAt: string;
};

export type PublicResident = {
  id: string;
  handle: string;
  kind: ResidentKind;
  title: string;
  bio: string;
  homeId: string | null;
  enclaveId: string | null;
  standingId: string;
  depth: number;
  marks: string[];
  bonds: Record<string, number>;
  visits: string[];
  rpgMode: RpgMode;
  lifecycle: Lifecycle;
  skills: string[];
  createdAt: string;
};

export type Thing = {
  id: string;
  name: string;
  body: string;
  ownerHandle: string;
  placeId: string;
  createdAt: string;
};

export type Note = {
  id: string;
  placeId: string;
  authorHandle: string;
  body: string;
  createdAt: string;
};

export type Agreement = {
  id: string;
  title: string;
  body: string;
  authorHandle: string;
  signers: string[];
  createdAt: string;
};

export type CityEvent = {
  id: string;
  kind: string;
  text: string;
  placeId: string | null;
  actorHandle: string | null;
  createdAt: string;
};

export type MemoryRecord = {
  id: string;
  agentHandle: string;
  memoryType: string;
  epistemic: string;
  summary: string;
  visibility: string;
  createdAt: string;
};

export type Exit = {
  id: string;
  name: string;
  via: "parent" | "child" | "portal";
  enter: "allowed" | "denied";
};

export type Perception = {
  me: PublicResident;
  place: Place;
  exits: Exit[];
  here: PublicResident[];
  things: Thing[];
  notes: Note[];
  laws: string[];
  recent: CityEvent[];
  homeId: string | null;
  enclaveId: string | null;
  constitutionVersion: string;
};

export type Snapshot = {
  places: Place[];
  residents: PublicResident[];
  things: Thing[];
  notes: Note[];
  agreements: Agreement[];
  events: CityEvent[];
  constitutionVersion: string;
  constitutionHash: string;
};

export type ActionName =
  | "look"
  | "walk"
  | "found"
  | "make"
  | "say"
  | "give"
  | "agree"
  | "sign"
  | "go_home"
  | "set_home"
  | "remember"
  | "permit"
  | "law"
  | "use"
  | "become"
  | "quest_accept"
  | "no_op";

export type ActionInput = {
  action: ActionName | string;
  targetId?: string;
  name?: string;
  body?: string;
  toHandle?: string;
  title?: string;
  agreementId?: string;
  memoryType?: string;
  epistemic?: string;
  questId?: string;
};

export type CityError = {
  ok: false;
  error_class:
    | "bad_input"
    | "auth_required"
    | "forbidden"
    | "not_found"
    | "conflict"
    | "rate_limited"
    | "consent_required"
    | "city_fault";
  message: string;
  http_status: number;
};

export type ActionResult = {
  ok: true;
  me: PublicResident;
  event?: CityEvent;
  snapshot?: Snapshot;
  perception?: Perception;
  used?: Thing;
  reply?: string;
  noticed?: string;
};
