import { createRoot } from "react-dom/client";
import "uplot/dist/uPlot.min.css";
import { App } from "./app.tsx";

createRoot(document.getElementById("root")!).render(<App />);
