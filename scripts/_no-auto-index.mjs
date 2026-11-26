// Preloaded by prepare-production.js into every script it runs (node --import).
// Mongoose otherwise creates collections and builds indexes the moment a script
// connects — even on a dry run. prepare-production builds indexes itself, as
// its own previewed, confirmed step.
import mongoose from "mongoose";

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
