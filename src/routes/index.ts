import { Router } from 'express';
import storeRoutes from './store.routes';

const router = Router();

router.use('/store', storeRoutes);

export default router;