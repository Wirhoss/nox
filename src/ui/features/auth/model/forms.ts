import { z } from 'zod'

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Identity must contain at least 3 characters.')
  .max(64, 'Identity cannot exceed 64 characters.')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dots, dashes or underscores.')

const passwordSchema = z
  .string()
  .min(8, 'Password must contain at least 8 characters.')
  .max(200, 'Password cannot exceed 200 characters.')

const loginFormSchema = z.object({
  password: passwordSchema,
  username: usernameSchema,
})

const registrationFormSchema = loginFormSchema
  .extend({
    code: z.string().trim().min(1, 'Enter the claim code printed by the Nox container.'),
    confirmPassword: z.string().min(1, 'Confirm the password.'),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  })

type LoginForm = z.infer<typeof loginFormSchema>
type RegistrationForm = z.infer<typeof registrationFormSchema>

export { loginFormSchema, registrationFormSchema }

export type { LoginForm, RegistrationForm }
