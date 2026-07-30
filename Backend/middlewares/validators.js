/**
 * @fileoverview Centralized input validation middleware.
 *
 * Provides reusable express-validator chains for all POST/PUT routes.
 * Each validator is an array of middleware that can be spread into routes:
 *
 *   router.post('/:id/decision', ...validateApprovalDecision, controller.makeDecision);
 *
 * The handleValidation middleware at the end of each chain checks for errors
 * and returns a structured 400 response if validation fails.
 *
 * @module middlewares/validators
 */

const { body, param, validationResult } = require('express-validator');
const mongoose = require('mongoose');

// ─── Shared Validation Handler ───────────────────────────────────────────────

/**
 * Middleware that checks the result of preceding express-validator chains.
 * If there are validation errors, returns 400 with structured error details.
 * Otherwise, passes control to the next middleware.
 */
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
}

// ─── Param Validators ────────────────────────────────────────────────────────

/**
 * Validates that :id param is a valid MongoDB ObjectId.
 * Prevents invalid ObjectIds from reaching controllers and causing CastErrors.
 */
const validateMongoId = [
  param('id')
    .custom((value) => mongoose.isValidObjectId(value))
    .withMessage('Invalid document ID format'),
  handleValidation
];

// ─── Approval Validators ────────────────────────────────────────────────────

/**
 * Validates the body of POST /api/approvals/:id/decision
 */
const validateApprovalDecision = [
  param('id')
    .custom((value) => mongoose.isValidObjectId(value))
    .withMessage('Invalid document ID format'),
  body('action')
    .trim()
    .isIn(['approve', 'reject', 'request_changes'])
    .withMessage('Action must be one of: approve, reject, request_changes'),
  body('comments')
    .if(body('action').isIn(['reject', 'request_changes']))
    .notEmpty()
    .withMessage('Comments are required when rejecting or requesting changes')
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Comments must not exceed 2000 characters'),
  handleValidation
];

// ─── Admin Validators ────────────────────────────────────────────────────────

/**
 * Validates the body of POST /admin/reject/:id
 */
const validateAdminReject = [
  param('id')
    .custom((value) => mongoose.isValidObjectId(value))
    .withMessage('Invalid document ID format'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Reason must not exceed 2000 characters'),
  body('comment')
    .optional()
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Comment must not exceed 2000 characters'),
  handleValidation
];

/**
 * Validates the body of POST /admin/request-changes/:id
 */
const validateAdminRequestChanges = [
  param('id')
    .custom((value) => mongoose.isValidObjectId(value))
    .withMessage('Invalid document ID format'),
  body('comment')
    .notEmpty()
    .withMessage('Comment is required when requesting changes')
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Comment must not exceed 2000 characters'),
  handleValidation
];

// ─── Workflow Validators ─────────────────────────────────────────────────────

/**
 * Validates the body of POST /api/workflows
 */
const validateWorkflowCreate = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Workflow name is required')
    .isLength({ min: 3, max: 100 })
    .withMessage('Workflow name must be between 3 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description must not exceed 1000 characters'),
  body('steps')
    .isArray({ min: 1 })
    .withMessage('At least one workflow step is required'),
  handleValidation
];

/**
 * Validates the body of PUT /api/workflows/:id
 */
const validateWorkflowUpdate = [
  param('id')
    .custom((value) => mongoose.isValidObjectId(value))
    .withMessage('Invalid workflow ID format'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Workflow name must be between 3 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Description must not exceed 1000 characters'),
  body('steps')
    .optional()
    .isArray({ min: 1 })
    .withMessage('Steps must be a non-empty array'),
  handleValidation
];

// ─── Auth Validators (for routes that don't already have them) ───────────────

/**
 * Validates the body of POST /forgot-password
 */
const validateForgotPassword = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),
  handleValidation
];

/**
 * Validates the body of POST /reset-password/:token
 */
const validateResetPassword = [
  param('token')
    .trim()
    .notEmpty()
    .withMessage('Reset token is required')
    .isHexadecimal()
    .withMessage('Invalid reset token format')
    .isLength({ min: 64, max: 64 })
    .withMessage('Invalid reset token length'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/)
    .withMessage('Password must include at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must include at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must include at least one number'),
  handleValidation
];

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  handleValidation,
  validateMongoId,
  validateApprovalDecision,
  validateAdminReject,
  validateAdminRequestChanges,
  validateWorkflowCreate,
  validateWorkflowUpdate,
  validateForgotPassword,
  validateResetPassword
};
