import mockPeopleProvider from "./mock.people.provider.js";
import httpPeopleProvider from "./http.people.provider.js";
import { peopleApiUrl } from "../../config/env.config.js";

/*
  Who answers a People Directory search: the real people API once
  PEOPLE_API_URL is set, the 🧪 test mock until then.

  A provider exposes:
    name, isTest
    channel                    the website channel its subscribers belong to
    search(q, { kind, limit }) → [normalised person]   (see http provider)
    get(kind, externalId)      → normalised person | null
*/
export const getPeopleProvider = () => (peopleApiUrl ? httpPeopleProvider : mockPeopleProvider);
