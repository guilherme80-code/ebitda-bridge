import { Router, type IRouter } from "express";
import healthRouter from "./health";
import bridgeRouter from "./bridge";
import explanationsRouter from "./explanations";
import marketExplanationsRouter from "./market-explanations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(bridgeRouter);
router.use(explanationsRouter);
router.use(marketExplanationsRouter);

export default router;
