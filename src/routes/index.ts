import { Router } from 'express';
import authRoutes from './auth.routes';
import storeRoutes from './store.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/store', storeRoutes);

export default router;