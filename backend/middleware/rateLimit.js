import rateLimit from 'express-rate-limit';
import { getClientIP } from '../utils/helpers.js';

function createLimiter(windowMs, max, message) {
  return rateLimit({
    windowMs, max,
    keyGenerator: (req) => `${getClientIP(req)}:${req.user?.id || 'anon'}`,
    handler: (req, res) => res.status(429).json({ success: false, message }),
    standardHeaders: true, legacyHeaders: false,
  });
}

export const loginLimiter = createLimiter(15 * 60 * 1000, 10, 'Too many login attempts. Please try again after 15 minutes.');
export const apiLimiter = createLimiter(60 * 1000, 120, 'Too many requests. Please slow down.');
export const importLimiter = createLimiter(60 * 1000, 5, 'Too many import requests. Please wait before importing again.');
export const recheckLimiter = createLimiter(60 * 1000, 10, 'Too many recheck requests. Please slow down.');
export const intelligenceLimiter = createLimiter(60 * 1000, 10, 'Too many intelligence requests. Please slow down.');
export const deleteLimiter = createLimiter(60 * 1000, 20, 'Too many delete requests. Please slow down.');
export const adminActionLimiter = createLimiter(60 * 1000, 30, 'Too many admin actions. Please slow down.');
export const forgotPasswordLimiter = createLimiter(15 * 60 * 1000, 5, 'Too many password reset requests. Please try again later.');
export const signupLimiter = createLimiter(15 * 60 * 1000, 5, 'Too many signup attempts. Please try again later.');
export const contactLimiter = createLimiter(15 * 60 * 1000, 10, 'Too many contact submissions. Please try again later.');
